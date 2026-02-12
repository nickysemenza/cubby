## Mobile PWA

**Target: iOS only** — no Android-specific APIs (e.g., `navigator.vibrate` is not available on iOS Safari). See `docs/plans/2026-01-05-mobile-first-experience-design.md` for design details.

## Quick Reference

- Format after changes: `pnpm run format:write`
- Typecheck + lint: `pnpm run check`
- Typecheck only: `pnpm run typecheck` (uses tsgo from TypeScript 7.0 preview for speed)
- Typecheck with stable TypeScript: `pnpm run typecheck:stable` (fallback if tsgo has issues)
- Dev server: `pnpm run dev`
- Build (CF Workers): `pnpm run build:cf`
- Test (unit): `pnpm run test`
- Test (e2e): `pnpm run test:e2e` (Playwright)
- DB migrations: `pnpm run db:migrate` (in `apps/web`)
- Todos: `docs/todos.md`

## Monorepo Structure

```
apps/web           — Main app (TanStack Start, tRPC, Drizzle)
apps/upc-lookup    — Cloudflare Worker for UPC lookups
apps/upc-scout     — UPC product scouting service
apps/usda-api      — USDA food data API
packages/usda-contract — ts-rest contract definitions
packages/usda-schemas  — Shared Zod schemas
packages/wasm      — WASM bindings for ingredient parser
```

## Architecture Layers

Request flow: **Router** (tRPC) → **Service** (optional) → **Repo** (data access) → **Database**

- **Routers** use the CRUD factory (`createEntityCrudProcedures` from `crud-factory.ts`) for standard CRUD operations
- **Services** exist only when entities need enrichment (e.g., USDA food data). Otherwise routers call repos directly
- **Repos** handle all database access through the opaque `Database` type

## Test Conventions

| Suffix | Purpose | Runner |
|---|---|---|
| `*.unit.test.ts` | Unit tests | Vitest |
| `*.integration.test.ts` | Integration tests (DB) | Vitest |
| `*.spec.ts` | E2E tests | Playwright |

## File Naming Conventions

| Pattern | Example | Used For |
|---|---|---|
| `*.service.ts` | `product.service.ts` | Service layer (enrichment) |
| `*-helpers.ts` | `database-helpers.ts` | Utility helpers |
| `*-utils.ts` | `location-utils.ts` | Utility functions |
| `types.ts` / `internal-types.ts` | `repo/product/types.ts` | Local type definitions |

## Environment Setup

See `apps/web/.env.example` for required environment variables. See `docs/style-guide.md` for CSS/Tailwind patterns.

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

## React Hooks: Preventing Infinite Render Loops

**CRITICAL**: Never pass inline object literals, arrays, or functions to hooks with dependencies. This creates new references on every render, triggering infinite loops.

### Bad (causes infinite re-renders):
```typescript
const { table } = useEntityList({
  deletable: {
    mutationOptions: (callbacks) => api.product.delete.mutationOptions(callbacks),
    entityLabel: "Product",
    invalidateKeys: [queryKeys.product.list],
  },
});
```

### Good (stable reference):
```typescript
const deletableConfig = useDeletableConfig({
  mutationFn: api.product.delete.mutationOptions,
  entityLabel: "Product",
  invalidateKeys: [queryKeys.product.list],
});

const { table } = useEntityList({
  deletable: deletableConfig,
});
```

**Rule**: If you're passing configuration objects to `useEntityList`, `useMemo`, `useEffect`, or any hook with dependencies, either:
1. Use `useDeletableConfig` helper for deletable configs
2. Wrap in `useMemo` with proper dependencies
3. Extract to a stable reference outside the component

### `useQueries` must use `combine`

`useQueries` returns a **new array reference on every render**. Deriving values from the raw result array (even inside `useMemo`) creates an unstable dependency chain that causes infinite re-renders when downstream `useEffect`s set state.

**Always** use the `combine` option, which applies structural sharing to keep the result referentially stable:

```typescript
// Bad — raw useQueries returns new array every render:
const queries = useQueries({ queries: queryOptions });
const data = useMemo(() => queries.map((q) => q.data).filter(Boolean), [queries]); // ← new ref every render

// Good — combine provides structural sharing:
const { data, isLoading } = useQueries({
  queries: queryOptions,
  combine: (results) => ({
    data: results
      .map((r) => r.data)
      .filter((d): d is NonNullable<typeof d> => d != null),
    isLoading: results.some((r) => r.isLoading),
  }),
});
```

### Optimistic Updates

All entity deletions use **optimistic updates** for instant UI feedback:

1. **onMutate**: Items are removed from the cache immediately (before the server responds)
2. **onSuccess**: Queries are invalidated to refetch and ensure consistency
3. **onError**: Previous data is restored if the mutation fails

This pattern is built into `useEntityList` - no additional code needed for list pages. Items disappear instantly when deleted, providing excellent UX while maintaining data integrity.

## Required Helpers

Use these instead of inline patterns:

| Pattern to avoid                                           | Use instead                                     | Import from                                  |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Inline deletable config object                             | `useDeletableConfig({ ... })`                   | `~/app/_components/hooks/useDeletableConfig` |
| Inline update mutation with `useMemo` + `useMutation`      | `useUpdateMutation({ ... })`                    | `~/app/_components/hooks/useUpdateMutation`  |
| `error instanceof Error ? error.message : "Unknown error"` | `getErrorMessage(error)`                        | `~/lib/error-utils`                          |
| Manual `.insert().values().returning()` + null check       | `insertAndReturn(db, table, values)`            | `~/server/repo/database-helpers`             |
| Manual `.update().set().where().returning()` + null check  | `updateAndReturn(db, table, values, where)`     | `~/server/repo/database-helpers`             |
| `getDb(db).transaction(async (tx) => {...})`               | `withTransaction(db, async (tx) => {...})`      | `~/server/repo/database-helpers`             |
| `ilike(column, \`%${term}%\`)`                             | `formatSearchTerm(column, term)`                | `~/server/repo/database-helpers`             |
| `isNull(table.deletedAt)`                                  | `notDeleted(table)`                             | `~/server/repo/database-helpers`             |
| Manual conditions array + notDeleted + formatSearchTerm    | `buildSearchConditions(table, filters, extras)` | `~/server/repo/database-helpers`             |
| `ComboboxItem.refine()` for required product               | `requiredProductField`                          | `~/schemas/form-fields`                      |
| `ComboboxItem.refine()` for required location              | `requiredLocationField`                         | `~/schemas/form-fields`                      |
| `as ProductId`, `as LocationId`, etc.                      | `unsafeProductId()`, `unsafeLocationId()`, etc. | `~/schemas/identifiers`                      |
| Inline `["inventoryItem"]` query keys                      | `queryKeys.inventoryItem.list`                  | `~/lib/query-keys`                           |
| `Array.from(new Set(arr))` or `[...new Set(arr)]`          | `dedupe(arr)`                                   | `~/misc/array-helpers`                       |
| `value === "(unspecified)"`                                | `isUnspecifiedManufacturer(value)`              | `~/lib/manufacturer-utils`                   |

## Authentication (Better-Auth)

- Server config: `apps/web/src/lib/auth.ts` (TanStack Start via `better-auth/tanstack-start`)
- Client: `apps/web/src/lib/auth-client.ts` (hooks: `useSession`)
- API route: `apps/web/src/routes/api/auth/$.ts`
- UI routes use `@daveyplate/better-auth-ui`:
  - Auth: `apps/web/src/routes/auth.$authView.tsx`
  - Account: `apps/web/src/routes/account.$accountView.tsx`

## Product Types

| Type                | Example                   | Characteristics                                                    |
| ------------------- | ------------------------- | ------------------------------------------------------------------ |
| **Specific Item**   | "Kraft Macaroni & Cheese" | Has UPC, manufacturer, price, nutrition. Created via barcode scan. |
| **Misc Collection** | "misc:random cables"      | Opaque placeholder. Just a name, no details. Prefix with `misc:`.  |

## Deployment (CF Workers)

Production deploys to Cloudflare Workers. Dev server runs plain Node.js via `vite dev`.

### Commands

- Build: `pnpm --filter @cubby/web run build:cf`
- Deploy: `pnpm --filter @cubby/web run deploy:cf`
- Preview: `pnpm --filter @cubby/web run preview:cf`
- Secrets: `wrangler secret put BETTER_AUTH_SECRET` (etc.) — see `wrangler.jsonc` for full list
- Hyperdrive: `wrangler hyperdrive create cubby-db --connection-string="postgres://..."` — update ID in `wrangler.jsonc`

### Architecture

| File | Purpose |
|---|---|
| `src/cf-server.ts` | Worker entry point — wraps each request with `withRequestDb()` |
| `src/server/db.ts` | Per-request `pg.Client` via AsyncLocalStorage (CF) or module-level Pool (dev) |
| `src/lib/recipebridge-cf.ts` | WASM wrapper using `?init` pattern for CF Workers |
| `wrangler.jsonc` | Worker config (name, vars, Hyperdrive binding, compatibility flags) |
| `vite.config.ts` | `cfWasmPlugin()` + conditional deploy plugin, `__CF_WORKERS__` define |

### Key Constraints

- **Hyperdrive for database**: Hyperdrive pools TCP connections at CF's edge, eliminating per-request WebSocket/TLS/auth overhead. Connection string comes from `env.HYPERDRIVE.connectionString`, not a secret. Uses standard `pg.Client`.
- **Per-request pg.Client**: Each Worker invocation gets its own `pg.Client` handle via `withRequestDb()` + `AsyncLocalStorage`, even though Hyperdrive reuses underlying connections.
- **WASM uses `?init` pattern**: `vite-plugin-wasm` doesn't apply to CF's SSR environment. `cfWasmPlugin()` redirects `@cubby/recipebridge` to `recipebridge-cf.ts` which uses `import initWasm from "file.wasm?init"` (supported by `@cloudflare/vite-plugin`).
- **`__CF_WORKERS__` dead code elimination**: `define: { __CF_WORKERS__: "true" }` in Vite config eliminates the module-level Pool creation from CF builds.
- **Error visibility**: `cf-server.ts` monkey-patches `console.error` to capture real error details for `wrangler tail`.
- **OTel disabled in production**: OTel SDK only runs in dev (via `instrument.server.mjs`).

## Unit Conversion (WASM)

- `recipebridge` package in monorepo wraps Rust WASM from `ingredient-parser` repo
- Client-side: `wasm` from `~/lib/wasm` (sync)
- Server-side: `wasmServer` (async, auto-initializing)
- Supports chained conversions through graph algorithms (e.g., "2 cups → $5.00 → 333g")
- Products have unit mappings (volume→price, weight→price, etc.)

## USDA Integration

- **Contract**: `@cubby/usda-contract` defines endpoints with Zod schemas (ts-rest)
- **Schemas**: `@cubby/usda-schemas` for shared entity types
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
