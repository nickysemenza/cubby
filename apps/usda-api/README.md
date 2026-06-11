# USDA API

Cloudflare Worker that serves Cubby's USDA food lookup API from D1 and R2.

## Runtime

- Hono Worker
- D1 for searchable metadata and R2 byte pointers
- D1 FTS5 for `description` search
- R2 for versioned, uncompressed NDJSON `FoodSummary` bundles

The public API contract stays in `packages/usda-contract`:

- `GET /counts`
- `GET /api/foods/:fdc_id`
- `POST /api/foods/search`
- `POST /api/foods/search/batch`
- `GET /api/foods`

## Development

Build and validate a small local edge fixture:

```bash
pnpm edge:build:sample
pnpm edge:validate:sample
pnpm edge:seed:local
pnpm dev
```

`wrangler dev` uses local D1/R2 state under `.wrangler/state`.

## Full Data Build

The local SQLite database remains the canonical build input for edge artifacts.
Create or refresh it with:

```bash
pnpm db:migrate
pnpm import:usda
```

Build Cloudflare artifacts from the SQLite DB:

```bash
pnpm edge:build -- --db data/usda.sqlite --out artifacts/usda-edge/vYYYYMMDD --version vYYYYMMDD
pnpm edge:validate -- --artifacts artifacts/usda-edge/vYYYYMMDD
```

This writes:

- `r2/usda/<version>/bundles/*.ndjson`
- `r2/usda/<version>/manifest.json`
- `d1/001_schema.sql`
- `d1/002_data.sql`
- `d1/003_finalize.sql`
- `d1/004_activate.sql`
- `pointers.ndjson`

Seed local Wrangler storage:

```bash
pnpm edge:seed:local -- --artifacts artifacts/usda-edge/vYYYYMMDD
```

Seed production Cloudflare resources:

```bash
pnpm edge:seed:remote -- --artifacts artifacts/usda-edge/vYYYYMMDD
```

The seed script uploads R2 bundles first, then imports D1 schema/data/finalize
SQL, then activates the version last.

## Deploy

```bash
pnpm deploy:worker
```

Current production resources are configured in `wrangler.jsonc`:

- D1 binding: `DB`
- R2 binding: `USDA_BUNDLES`

## Notes

- `artifacts/`, `.wrangler/`, and `dist/` are generated and ignored.
- Search intentionally indexes only `description`.
- Full relational USDA queries are not supported at runtime; full records are
  materialized into R2 bundle lines and hydrated by D1 byte pointers.
