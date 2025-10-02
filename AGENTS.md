## General Guidelines

- read the readme.md to understand project structure
- after touching files, format them with prettier
- ensure the typechecker and linter is happy with all changes (pnpm run check)
- todos are kept in @docs/todos.md
- helper functions should not be added without being used
- **IMPORTANT**: When architecture, routes, schemas, or integration patterns change, always update both AGENTS.md and relevant README.md files to keep documentation current and accurate

## Type Safety & Schema Patterns

- whenever possible, types should be derived from common zod schemas
- import existing types instead of redefining or casting them
- avoid using `any` type - use proper typing with generics, unions, or specific types instead
- do not add @typescript-eslint/no-explicit-any disable comments - fix the typing instead
- create base Zod schemas for shared fields using `.extend()` to avoid duplication (e.g., baseProductConfig with common fields extended by input/output variants)
- use separate input/output schemas when data transformation is needed (e.g., strings -> parsed objects)

## Architecture Patterns

- follow the layered architecture: schemas -> repos -> routers -> components
- maintain entity-based organization (recipes, products, ingredients, locations, etc.)
- since many of the forms / routers / repos / etc are the same between entities (recipes, locations, products, etc), try to use common helper functions as much as possible
- use common helper functions across similar entities instead of duplicating logic

## Form Patterns

- use FormWrapper component for consistent form layout with submit/cancel buttons
- use mode-based props: CreateModeProps and EditModeProps for forms
- use common field components: UnifiedTextField, ComboboxField, SelectField, etc.
- for dynamic arrays, use ArrayFieldManager component
- use buildUpdateObject helper to detect changed fields in edit forms
- use detectComboboxIdChange helper for combobox field updates

## Database & API Patterns

### Database Access Control

- **Opaque Database Type**: The `Database` type is opaque (branded) and prevents direct method calls outside of repo files
- **Repo Layer Only**: All direct database operations (`.findMany()`, `.create()`, etc.) must be in `/server/repo/` files
- **Services as Plumbing**: Services accept `Database` but cannot call methods on it - they only pass it to repo functions
- **Using getDb()**: In repo functions that accept `db: Database`, call `const prisma = getDb(db)` to access PrismaClient methods
- **Transactions**: Use `withTransaction(db, async (tx) => {...})` for atomic operations - `tx` is already a `PrismaClient`
- **Pattern**: Functions that accept `Prisma.TransactionClient` (usually named `tx`) can call methods directly without `getDb()`

### Other Patterns

- extend baseEntitySchema for entities with id, name, and timestamps
- use extractDbTimestampsFromDBRec helper for timestamp fields
- use formatSearchTerm helper for consistent database searches
- use sortPaginationCombo schema and buildPaginatedResponse for paginated endpoints
- follow tRPC patterns with input/output schemas and publicProcedure

## Testing Patterns

- unit tests: .unit.test.ts suffix
- integration tests: .integration.test.ts suffix
- e2e tests: in /tests/e2e directory
- test common utilities like cn() function for class merging
- use Playwright MCP for browser automation and e2e testing when working with web UI interactions

## Git & GitHub Patterns

- use GitHub CLI (gh) for GitHub-related operations: issues, pull requests, releases
- follow standard git commit message format with descriptive summaries
- use conventional commit prefixes when appropriate (feat:, fix:, refactor:, etc.)
- only commit changes when explicitly requested by the user
- when creating PRs, include clear summary and test plan sections

## UI/UX Patterns

- use cn() utility for merging Tailwind classes with conflict resolution
- use lucide-react icons consistently
- use SideBySideFields component for two-column form layouts
- follow shadcn/ui component patterns in src/components/ui
- use class-variance-authority (CVA) for component variants when there are multiple styling options

## Unit Conversion & WASM Architecture

**Critical**: The unit conversion system is powered by a separate WASM-compiled Rust crate from `../ingredient-parser/ingredient-parser/`.

### Key Architecture Points:

- **Separate Repository**: `ingredient-parser` is a separate Git repository containing the Rust unit conversion engine
- **WASM Integration**: The Rust code is compiled to WebAssembly and loaded via `useWasm()` hook
- **Chained Conversions**: The WASM engine supports powerful chained conversions (e.g., "2 cups → $5.00 → 333g" through intermediate units)
- **Graph-Based**: Uses graph algorithms to find conversion paths through multiple unit mappings

### Unit Mapping System:

- **Product Unit Mappings**: Products can have multiple unit mappings (volume→price, weight→price, etc.)
- **Bidirectional Graphs**: WASM creates bidirectional conversion graphs from mappings
- **Error Handling**: Weight conversion should work independently of nutrition data availability

## USDA Database Integration

**Overview**: The USDA FoodData Central database provides comprehensive nutrition and food information, integrated via a separate API service and shared schema package.

### Key Integration Points:

- **Zod-First Contract**: `@recipehub/usda-contract` defines endpoints with Zod schemas via ts-rest. This is the single source of truth.
- **Shared Schemas**: `@recipehub/usda-schemas` provides core entity schemas consumed by the contract and both apps.
- **USDAClient**: Abstraction layer in `src/server/clients/usda.ts` calls the ts-rest client generated from the shared contract.
- **Product Linking**: Products can be linked to USDA foods via UPC codes or legacy NDB numbers
- **Nutrition Data**: USDA provides detailed nutrient information and portion mappings

### Common Usage Patterns:

- **Find by Lookup**: `usdaClient.findFood({ kind: "upc", gtin_upc: "123456789012" })` or `usdaClient.findFood({ kind: "ndb", ndb_number: 12345 })` (single consolidated endpoint)
- **Search Foods**: `usdaClient.listFoods(nameFilter, dataTypeFilter, sort, pagination)`
- **Get Details**: `usdaClient.getFoodSummaryByID(fdcId)`

### Service Layer Integration:

- **WASM Processing**: Service layer processes USDA portion data through WASM for unit conversions
- **tRPC Router**: `src/server/api/routers/usda.ts` exposes USDA functionality to frontend
- **Type Safety**: All USDA data uses Zod schemas from the shared contract/schemas for runtime validation and TS types

### Database Management and Cache Busting:

- **Automatic Updates**: USDA API automatically detects database updates via version comparison
- **Cache Invalidation**: Upload script generates version timestamps and checksums for intelligent cache busting
- **Integrity Verification**: SHA256 checksums ensure database integrity during downloads
- **Manual Override**: Use `FORCE_DB_REFRESH=1` environment variable to force fresh database download

### Database Deployment Workflow:

1. **Local Import**: Run `pnpm import:usda` to process CSV files into SQLite
2. **Upload to R2**: Run `pnpm upload:db` to compress and upload with versioning
3. **Auto-Deploy**: Fly.io containers automatically detect and download updated database
4. **Cache Busting**: Version timestamps ensure fresh downloads when database changes

### Performance Considerations:

- **Caching**: USDA API responses should be cached appropriately
- **Batch Operations**: Use list endpoints for multiple food lookups
- **Database Location**: USDA API runs as separate service with SQLite database on Fly.io
- **Volume Persistence**: Database persists on Fly volumes between deployments

### Contract Notes

- OpenAPI generation and Swagger UI have been removed. Consumers internal to Recipehub use the ts-rest client from `@recipehub/usda-contract`.
- Server routes validate inputs/outputs with the same Zod schemas to prevent drift.

### Nullability Rules (USDA DB)

- The following columns are NOT NULL. The importer enforces this with targeted handling:
  - `usda_food.description`: If empty string in CSV, importer writes "<empty>" to retain the row and preserve foreign keys on `fdc_id`.
  - `usda_food_nutrient.amount`: Rows with null/empty values are skipped.
  - `usda_food_portion.amount`: Rows with null/empty values are skipped.
  - `usda_food_portion.gram_weight`: Rows with null/empty values are skipped.
  This is enforced in both the Drizzle schema and migrations; importer substitutes for description and skips other invalid rows.
