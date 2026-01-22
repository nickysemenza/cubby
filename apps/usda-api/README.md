# USDA DB Hono + Drizzle (SQLite)

A minimal Hono app using Drizzle ORM with a local SQLite database. Schema is derived from the provided Prisma models. The root route (`/`) returns row counts for each table.

## Stack

- Hono (`@hono/node-server`)
- Drizzle ORM + better-sqlite3
- SQLite (local file)
- Fly.io deploy (with a volume mounted at `/data`)

## Project Layout

- `src/db/schema.ts` — Drizzle schema mirroring the Prisma models
- `drizzle/0000_init.sql` — SQL migration to create tables and indexes
- `src/db/client.ts` — DB setup, migrations, and small helpers
- `src/index.ts` — Hono server with a single route
- `fly.toml` / `Dockerfile` — Fly deployment config

## Setup

1. Install deps

- pnpm: `pnpm install`

2. Initialize the database

- Create local SQLite file and apply migrations: `pnpm run migrate` (will create `./data/usda.sqlite` and apply `drizzle/0000_init.sql`).

3. Run dev server

- `pnpm run dev`
- Open `http://localhost:8080/` to see counts

4. Build + run

- `pnpm run build && pnpm start`

## Fly.io Deployment

### Database Download and Cache Management

The USDA API automatically downloads and manages the SQLite database from Cloudflare R2 with intelligent cache busting:

#### Database Upload (zstd)

Upload your local database with zstd compression and automatic versioning:

```bash
pnpm upload:db [database-path]

# With custom options
pnpm upload:db --bucket my-bucket --key custom-key.zst

Compression defaults target smaller size (zstd level 12 with multi-threading).
```

This TypeScript script:

1. **Compresses** the database using zstd (`.zst`)
2. **Generates version** timestamp for cache invalidation
3. **Creates checksum** for integrity verification
4. **Uploads three files** to R2 via rclone:
   - `usda.sqlite.zst` (compressed database)
   - `usda.sqlite.version` (version timestamp)
   - `usda.sqlite.zst.sha256` (integrity checksum)

**Requirements (runtime and upload):**

- `R2_ACCOUNT_ID` — Cloudflare account ID
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` — R2 API keys
- `R2_BUCKET` — R2 bucket name
- `R2_OBJECT_KEY` — Object key (e.g., `usda.sqlite.zst`)

#### Automatic Cache Busting

The TypeScript Docker entrypoint intelligently manages database updates:

**On startup, the container:**

1. **Checks for updates** by reading the version object from R2 (`<OBJECT_KEY>.version`)
2. **Downloads fresh database** from R2 if version differs or doesn't exist
3. **Decompresses** the zstd archive
4. **Persists locally** for future startups

#### Environment Variables

**Optional:**

- `FORCE_DB_REFRESH=1` — Force download fresh database on next restart
- `DOWNLOAD_QUIET=1` — Suppress download progress output

#### Deployment Steps

1. **Create volume and deploy:**

   ```bash
   fly volumes create data --region <REGION> --size 10
   fly deploy
   ```

2. **Update database** (when needed):

   ```bash
   # Upload new database version
   pnpm upload:db

   # Restart to pick up changes (automatic detection)
   fly restart

   # Or force immediate refresh
   fly restart --env FORCE_DB_REFRESH=1
   ```

#### Manual Cache Invalidation

If needed, manually clear the cache:

```bash
# Remove database files and restart
fly ssh console -C "rm -f /data/usda.sqlite*"
fly restart
```

**Configuration Notes:**

- `DATABASE_PATH` defaults to `/data/usda.sqlite` (set in `fly.toml`)
- Database persists on Fly volume between deployments
- Runtime requires R2 envs: `R2_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_OBJECT_KEY`

### Faster Imports on Fly

For heavy USDA imports, temporarily scale up your Fly app, run the import, then scale down:

```bash
# Scale up CPU and memory (example: performance 4x CPUs, 8GB RAM)
fly scale vm performance-4x --yes
fly scale memory 8192 --yes

# Run the import inside the machine
fly ssh console -C "cd /app/apps/usda-api && pnpm import:usda"

# Scale back down when finished (adjust values to your baseline)
fly scale vm shared-cpu-1x --yes
fly scale memory 512 --yes
```

Notes:
- Ensure your Fly app has adequate volume size before importing.
- You can also set `FORCE_DB_REFRESH=1` and restart to pull the newly uploaded DB snapshot instead of re-importing.

## Notes

- The original Prisma GIN/trigram index is Postgres-specific; in SQLite we create a normal index on `usda_food.description` instead.
- Decimal fields are stored as `REAL` in SQLite.
- Foreign keys are defined and enforced by SQLite (`PRAGMA foreign_keys=ON`).

## Database Architecture

### Core Tables

The SQLite database mirrors USDA FoodData Central structure:

- **`usda_food`** - Core food records with FDC ID, description, data type
- **`usda_branded_food`** - Commercial food products with UPC codes, brand info, ingredients
- **`usda_nutrient`** - Nutrient definitions (protein, vitamins, minerals, etc.)
- **`usda_food_nutrient`** - Nutrient amounts per food item
- **`usda_measure_unit`** - Unit definitions (cup, gram, tablespoon, etc.)
- **`usda_food_portion`** - Portion size mappings (1 cup = 240g)
- **`usda_sr_legacy_food`** - Legacy NDB number mappings

#### Nullability Rules

- To ensure data quality and simplify APIs, the following columns are NOT NULL. The importer enforces these rules as follows:
  - `usda_food.description`: If the CSV value is an empty string, the importer substitutes "<empty>" to preserve the row and maintain referential integrity on `fdc_id`.
  - `usda_food_nutrient.amount`: Rows with null/empty amounts are dropped during CSV import.
  - `usda_food_portion.amount`: Rows with null/empty amounts are dropped during CSV import.
  - `usda_food_portion.gram_weight`: Rows with null/empty gram weights are dropped during CSV import.
  These constraints are enforced by Drizzle migrations and the import script.

### Full-Text Search

Uses SQLite FTS5 for fast food search:

- **`food_search`** - Virtual FTS5 table indexing descriptions, brand names
- Supports prefix matching for responsive search
- Optimized with prepared statements

### Performance Optimizations

- Strategic indexes on frequently queried columns
- Prepared statements for all queries
- Composite queries combining multiple tables
- FTS5 virtual table for text search

## API Endpoints (Zod-first)

### Core Endpoints

- `GET /` - Database table counts
- `GET /api/foods/{fdc_id}` - Complete food information by FDC ID
- `POST /api/foods/search` - Find food by lookup (UPC or NDB) using discriminated union body
- `GET /api/foods` - Paginated food search with filters

### Query Parameters (List Foods)

- `nameFilter` - Text search across descriptions and brand names
- `dataTypeFilter` - Filter by data type (branded_food, sr_legacy_food, etc.)
- `orderBy` - Sort by description, data_type, or fdc_id
- `direction` - Sort direction (asc/desc)
- `pageIndex` - Zero-based page number
- `pageSize` - Items per page

### Response Format

All food endpoints return complete food information validated by Zod and defined in the shared contract `@cubby/usda-contract`:

```json
{
  "fdc_id": 123456,
  "foodInfo": {
    "data_type": "branded_food",
    "description": "Pizza, cheese"
  },
  "brandedFoodInfo": {
    "brand_owner": "Example Corp",
    "brand_name": "Example Brand",
    "gtin_upc": "123456789012",
    "ingredients": "Flour, cheese, sauce...",
    "serving": {
      "serving_size": 100,
      "serving_size_unit": "g"
    }
  },
  "nutritionInfo": {
    "nutrientSummary": [
      {
        "amount": 10.5,
        "name": "Protein",
        "unit": "G"
      }
    ],
    "nutrientsPer100": {
      "protein": 10.5,
      "kcal": 250
    }
  },
  "portionInfo": {
    "raw": [
      {
        "amount": 1,
        "modifier": "slice",
        "gram_weight": 30
      }
    ]
  }
}
```

## Data Import Process

### Import Script

`pnpm import:usda` runs the import process:

1. Downloads USDA FoodData Central CSV files
2. Parses and validates data using Zod schemas
3. Bulk inserts into SQLite with transaction safety
4. Rebuilds FTS5 search index
5. Optimizes database with VACUUM and ANALYZE

### CSV Files Processed

- `food.csv` - Core food records
- `branded_food.csv` - Branded food information
- `nutrient.csv` - Nutrient definitions
- `food_nutrient.csv` - Nutrient values per food
- `measure_unit.csv` - Measurement units
- `food_portion.csv` - Portion mappings
- `sr_legacy_food.csv` - Legacy NDB mappings

## Development Setup

### Local Development

```bash
# Install dependencies
pnpm install

# Initialize database and apply migrations
pnpm db:migrate

# Import USDA data (optional - large download)
pnpm import:usda

# Start development server
pnpm dev

# Verify API responds
open http://localhost:8080/
open http://localhost:8080/api/foods?pageSize=1
```

### Testing

```bash
# Run type checking
pnpm typecheck

# Run linting
pnpm lint

# Format code
pnpm format:write
```

## Contract

- The API contract lives in `packages/usda-contract` and is consumed by the web client via `@ts-rest/core`.
- No OpenAPI generation is used; the contract is the single source of truth for request/response shapes.

## Route

- `GET /` — returns JSON counts of: `usda_food`, `usda_branded_food`, `usda_nutrient`, `usda_food_nutrient`, `usda_measure_unit`, `usda_food_portion`, `usda_sr_legacy_food`.
### Find Lookup Request Body

Body uses the shared discriminated union `foodLookupParam`:

```jsonc
// UPC
{ "kind": "upc", "gtin_upc": "123456789012" }

// NDB
{ "kind": "ndb", "ndb_number": 12345 }
```
