## General Guidelines

- read the readme.md to understand project structure
- after touching files, format them with Biome (`pnpm run format:write`)
- ensure the typechecker and linter is happy with all changes (pnpm run check)
- todos are kept in docs/todos.md
- helper functions should not be added without being used
- prefer arrow functions for simple helpers: `const foo = (x: T) => ({ ... })` over `function foo(x: T) { return { ... } }`
- **IMPORTANT**: When architecture, routes, schemas, or integration patterns change, always update both AGENTS.md and relevant README.md files to keep documentation current and accurate

## Avoiding Backwards Compatibility Debt

When refactoring, **do not create backwards compatibility shims**. Instead:

- **Delete, don't deprecate**: Remove old code entirely rather than marking it `@deprecated` or adding "for backwards compatibility" comments
- **Update all call sites**: When renaming types/functions, update all usages in the same PR rather than creating aliases
- **No wrapper components**: Don't create thin wrappers "for backwards compatibility" - inline the usage directly
- **No type aliases for renames**: If renaming `Transaction` → `DrizzleTransaction`, update all imports rather than `export type Transaction = DrizzleTransaction`
- **Use generic patterns from the start**: When adding entity-specific helpers (e.g., CSV counters), check if a generic pattern exists first (e.g., `createCounters<TAction>`) rather than creating one-off implementations that later need consolidation

**Why**: Backwards compatibility code accumulates silently and creates confusion about which pattern to use. It's easier to update all call sites in one pass than to maintain parallel code paths.

## Type Safety & Schema Patterns

- whenever possible, types should be derived from common zod schemas
- import existing types instead of redefining or casting them
- **IMPORTANT**: Component interfaces should use `z.infer<typeof schema>` rather than manually defining matching TypeScript interfaces. Define Zod schemas in `~/schemas/` and import them directly where needed.
- avoid using `any` type - use proper typing with generics, unions, or specific types instead
- do not add biome-ignore or lint disable comments - fix the typing instead
- create base Zod schemas for shared fields using `.extend()` to avoid duplication (e.g., baseProductConfig with common fields extended by input/output variants)
- use separate input/output schemas when data transformation is needed (e.g., strings -> parsed objects)
- **use branded ID schemas** from `~/schemas/identifiers` (e.g., `locationId`, `productId`, `inventoryId`) instead of plain `z.string()` for ID fields - this provides type safety and prevents mixing different entity IDs. Note: Drizzle column types don't support branded types directly, so use unsafe ID converters (e.g., `unsafeLocationId()`) at the repo/DB boundary
- **minimize re-exports** - consumers should import directly from the source file (e.g., `~/schemas/foo`) rather than through intermediate re-exports; re-exports add indirection and can create circular dependency issues

## Architecture Patterns

- follow the layered architecture: schemas -> repos -> routers -> components
- maintain entity-based organization (recipes, products, ingredients, locations, etc.)
- since many of the forms / routers / repos / etc are the same between entities (recipes, locations, products, etc), try to use common helper functions as much as possible
- use common helper functions across similar entities instead of duplicating logic

### Required Helper Functions

Use these shared helpers instead of writing inline patterns. **Check for existing helpers before writing new code.**

| Pattern to avoid | Use instead | Import from |
|-----------------|-------------|-------------|
| `error instanceof Error ? error.message : "Unknown error"` | `getErrorMessage(error)` | `~/lib/error-utils` |
| Manual `.insert().values().returning()` + null check | `insertAndReturn(tx, table, values)` | `~/server/repo/database-helpers` |
| Same for `Database` type (not transaction) | `insertAndReturnDb(db, table, values)` | `~/server/repo/database-helpers` |
| Manual `.update().set().where().returning()` + null check | `updateAndReturn(tx, table, values, where)` | `~/server/repo/database-helpers` |
| `getDb(db).transaction(async (tx) => {...})` | `withTransaction(db, async (tx) => {...})` | `~/server/repo/database-helpers` |
| `ilike(column, \`%${term}%\`)` | `formatSearchTerm(column, term)` | `~/server/repo/database-helpers` |
| `ComboboxItem.refine()` for required product | `requiredProductField` | `~/schemas/form-fields` |
| `ComboboxItem.refine()` for required location | `requiredLocationField` | `~/schemas/form-fields` |
| `as ProductId`, `as LocationId`, etc. | `unsafeProductId()`, `unsafeLocationId()`, etc. | `~/schemas/identifiers` |
| Inline `["inventoryItem"]` query keys | `queryKeys.inventoryItem.list` | `~/lib/query-keys` |
| `Array.from(new Set(arr))` or `[...new Set(arr)]` | `dedupe(arr)` | `~/misc/array-helpers` |
| `value === "(unspecified)"` | `isUnspecifiedManufacturer(value)` | `~/lib/manufacturer-utils` |

### Authentication (Better‑Auth)

- Better‑Auth is the auth system for the web app.
- Server config: `apps/web/src/lib/auth.ts` (Next.js integration via `better-auth/next-js`).
- Client: `apps/web/src/lib/auth-client.ts` (React hooks such as `useSession`, `useListOrganizations`, `useActiveOrganization`).
- API route: `apps/web/src/app/api/auth/[...all]/route.ts` exports `{ GET, POST }` from `toNextJsHandler(auth)`.
- Organization plugin is enabled and fully adopted. Custom Project/Member codepaths are deprecated and removed from the UI and routers. Use organizations for scoping.
- UI: `@daveyplate/better-auth-ui` dynamic routes are used for all auth/account/org views
  - Auth: `apps/web/src/app/auth/[path]/page.tsx` → `<AuthView path={path}/>`
  - Account: `apps/web/src/app/account/[path]/page.tsx` → `<AccountView path={path}/>`
  - Organization: `apps/web/src/app/organization/[path]/page.tsx` → `<OrganizationView path={path}/>`
  - CSS: import `@daveyplate/better-auth-ui/css` in `apps/web/src/app/layout.tsx`

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
- **Repo Layer Only**: All direct database operations (`.query.table.findMany()`, `.insert()`, `.update()`, etc.) must be in `/server/repo/` files
- **Services as Plumbing**: Services accept `Database` but cannot call methods on it - they only pass it to repo functions
- **Using getDb()**: In repo functions that accept `db: Database`, call `getDb(db)` to access the DrizzleClient
- **Using unwrapDb()**: For functions accepting `Database | Transaction`, use `unwrapDb(db)` to safely handle both types
- **Transactions**: Use `withTransaction(db, async (tx) => {...})` for atomic operations - `tx` is a `DrizzleTransaction`
- **Pattern**: Functions that accept `DrizzleTransaction` (usually named `tx`) can call methods directly without `getDb()`
- **Helper Functions**: Use `insertAndReturn()`, `updateAndReturn()`, `buildOrderBy()`, `buildPartialUpdateValues()`, and relation helpers from `database-helpers.ts` to reduce boilerplate

### Service Layer Architecture

The service layer (`/server/services/`) is used selectively for entities that require external API enrichment or complex business logic:

- **When to use services**: Product and Ingredient have services because they integrate with USDA external API for nutrition data enrichment
- **When to skip services**: Location, Inventory, and Recipe call repos directly from routers since they don't require external enrichment
- **Pattern**: Services accept `Database` but only pass it to repo functions - they handle orchestration and external API calls

### Product Types

Products fall into two categories based on their level of detail:

| Type | Example | Characteristics |
|------|---------|-----------------|
| **Specific Item** | "Kraft Macaroni & Cheese" | Has UPC, manufacturer, price, nutrition data. Created via barcode scan or full product form. |
| **Misc Collection** | "misc:random cables" | Opaque placeholder for a group of items. Just a name, no UPC/manufacturer/price. Never gets detailed info. |

**Naming convention:** Products prefixed with `misc:` are opaque collections. The Scanner page (`/inventory/scanner`) provides a checkbox to toggle misc mode for batch entry.

**When to use each:**
- **Specific Item**: Individual trackable products (food, electronics, tools with barcodes)
- **Misc Collection**: Groups of small items not worth tracking individually (cables drawer, misc screws, office supplies)

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

- **prefer shadcn/ui components** over custom implementations - search for existing components before building new ones
- use cn() utility for merging Tailwind classes with conflict resolution
- use lucide-react icons consistently
- use SideBySideFields component for two-column form layouts
- follow shadcn/ui component patterns in src/components/ui
- use class-variance-authority (CVA) for component variants when there are multiple styling options
- use `<ImageWithPreview>` for all thumbnails - shows larger preview on hover, supports optional `href` for linking

## Unit Conversion & WASM Architecture

**Critical**: The unit conversion system is powered by a WASM-compiled Rust crate located in the monorepo at `/recipebridge/`.

### Key Architecture Points:

- **Monorepo Package**: `recipebridge` is in the monorepo and provides the WASM integration wrapper
- **External Dependency**: Depends on `ingredient-parser` (separate Git repository at https://github.com/nickysemenza/ingredient-parser) containing the Rust unit conversion engine. Likely to be checked out in `../ingredient-parser`
- **WASM Integration**: The Rust code is compiled to WebAssembly. Use `wasm` from `~/lib/wasm` for client-side code (sync), or `wasmServer` for server-side code (async, auto-initializing)
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
- always run `pnpm run lint` to ensure there are no type errors
