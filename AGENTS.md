## Quick Reference

- Format after changes: `pnpm run format:write`
- Typecheck + lint: `pnpm run check`
- Todos: `docs/todos.md`

## Branded IDs

Use branded ID schemas from `~/schemas/identifiers` (e.g., `locationId`, `productId`) instead of plain `z.string()`. This prevents mixing up entity IDs at compile time.

Drizzle doesn't support branded types directly, so use unsafe converters (`unsafeLocationId()`, `unsafeProductId()`) at the repo/DB boundary only.

## Opaque Database Type

The `Database` type is opaque (branded) - you can't call methods on it outside repo files. This enforces the layered architecture:

- **Routers** accept `Database`, pass it to repos or services
- **Services** accept `Database`, pass it to repos (can't query directly)
- **Repos** call `getDb(db)` to unwrap and access the actual DrizzleClient
- **Transactions** use `withTransaction(db, async (tx) => {...})` - `tx` is unwrapped and can be used directly

## Soft Delete

All major entities (products, recipes, locations, ingredients, inventory) use soft delete with a `deletedAt` timestamp column. Deleted items are retained in the database but hidden from normal queries.

**Key points:**
- Always use `notDeleted(table)` helper to filter out deleted records in queries
- Delete operations cascade to related entities (e.g., deleting a product soft-deletes its images and unit mappings)
- All deletions are wrapped in transactions and logged to audit trail
- Safety checks prevent deletion of entities with dependencies (e.g., products with inventory)
- **Restore functionality is intentionally not implemented** - treat soft deletes as permanent from a user perspective

## Required Helpers

Use these instead of inline patterns:

| Pattern to avoid | Use instead | Import from |
|-----------------|-------------|-------------|
| `error instanceof Error ? error.message : "Unknown error"` | `getErrorMessage(error)` | `~/lib/error-utils` |
| Manual `.insert().values().returning()` + null check | `insertAndReturn(tx, table, values)` | `~/server/repo/database-helpers` |
| Same for `Database` type (not transaction) | `insertAndReturnDb(db, table, values)` | `~/server/repo/database-helpers` |
| Manual `.update().set().where().returning()` + null check | `updateAndReturn(tx, table, values, where)` | `~/server/repo/database-helpers` |
| `getDb(db).transaction(async (tx) => {...})` | `withTransaction(db, async (tx) => {...})` | `~/server/repo/database-helpers` |
| `ilike(column, \`%${term}%\`)` | `formatSearchTerm(column, term)` | `~/server/repo/database-helpers` |
| `isNull(table.deletedAt)` | `notDeleted(table)` | `~/server/repo/database-helpers` |
| `ComboboxItem.refine()` for required product | `requiredProductField` | `~/schemas/form-fields` |
| `ComboboxItem.refine()` for required location | `requiredLocationField` | `~/schemas/form-fields` |
| `as ProductId`, `as LocationId`, etc. | `unsafeProductId()`, `unsafeLocationId()`, etc. | `~/schemas/identifiers` |
| Inline `["inventoryItem"]` query keys | `queryKeys.inventoryItem.list` | `~/lib/query-keys` |
| `Array.from(new Set(arr))` or `[...new Set(arr)]` | `dedupe(arr)` | `~/misc/array-helpers` |
| `value === "(unspecified)"` | `isUnspecifiedManufacturer(value)` | `~/lib/manufacturer-utils` |

## Authentication (Better-Auth)

- Server config: `apps/web/src/lib/auth.ts` (TanStack Start via `better-auth/tanstack-start`)
- Client: `apps/web/src/lib/auth-client.ts` (hooks: `useSession`)
- API route: `apps/web/src/routes/api/auth/$.ts`
- UI routes use `@daveyplate/better-auth-ui`:
  - Auth: `apps/web/src/routes/auth.$authView.tsx`
  - Account: `apps/web/src/routes/account.$accountView.tsx`

## Product Types

| Type | Example | Characteristics |
|------|---------|-----------------|
| **Specific Item** | "Kraft Macaroni & Cheese" | Has UPC, manufacturer, price, nutrition. Created via barcode scan. |
| **Misc Collection** | "misc:random cables" | Opaque placeholder. Just a name, no details. Prefix with `misc:`. |

## Unit Conversion (WASM)

- `recipebridge` package in monorepo wraps Rust WASM from `ingredient-parser` repo
- Client-side: `wasm` from `~/lib/wasm` (sync)
- Server-side: `wasmServer` (async, auto-initializing)
- Supports chained conversions through graph algorithms (e.g., "2 cups → $5.00 → 333g")
- Products have unit mappings (volume→price, weight→price, etc.)

## USDA Integration

- **Contract**: `@recipehub/usda-contract` defines endpoints with Zod schemas (ts-rest)
- **Schemas**: `@recipehub/usda-schemas` for shared entity types
- **Client**: `src/server/clients/usda.ts` wraps ts-rest client

Usage:
```typescript
// Find by UPC or NDB
usdaClient.findFood({ kind: "upc", gtin_upc: "123456789012" })
usdaClient.findFood({ kind: "ndb", ndb_number: 12345 })

// Search and details
usdaClient.listFoods(nameFilter, dataTypeFilter, sort, pagination)
usdaClient.getFoodSummaryByID(fdcId)
```

- tRPC router: `src/server/api/routers/usda.ts`
- Service layer processes USDA portion data through WASM for conversions
