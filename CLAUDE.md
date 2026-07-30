[README.md](README.md) is the canonical source of truth for the project — architecture, monorepo layout, deploy targets, commands, entities, environment, and the roadmap. Read it first. This file contains only rules and anti-patterns for the Claude agent. When you need context that isn't a rule, go to README rather than embedding the answer here.

The **[Tenets](README.md#tenets)** there are binding on design proposals: inventory never auto-decrements (no cook-and-consume), `fdc_id` is product-only (nutrition goes `ingredient → product → fdc_id`), rare interactive work stays off the background queue, and all money lives on `Expense` (`purchase.statedTotal` is never summed into spend). Don't propose a feature that contradicts one — say it's out of scope and why.

## Where logic lives (layering)

Three layers, one rule: never recompute in a higher layer what a lower one already owns.

- **`ingredient-parser` crates** (`ingredient`, `recipe-scraper`, `recipe-epub`, `recipe-types`) — pure ingredient / unit / recipe-shape logic, with **no** cubby-domain concepts (products, USDA `fdc_id`, prices, inventory, nutrient codes). Shared by `recipebridge` (WASM) **and** the native tools (food-cli / food-app). The deps-light contract.
- **`recipebridge`** (cubby's WASM crate) — cubby-domain compute (recipe costing, availability evaluation, food-mapping synthesis from products + USDA) plus the WASM boundary (`W*` tsify types, serde-wasm-bindgen marshalling). The single source of truth for those engines, consumed by the browser **and** the server (`*.service.ts`) via WASM. **Do not move these engines into `ingredient-parser`** — they're application domain with no upstream consumer; that's a layering violation, not consolidation. (Pure, generic unit helpers with no cubby coupling are the *only* thing that may migrate down — see the TODO in `recipebridge/src/reconcile.rs`.)
- **TS (`apps/web`)** — a thin boundary: assemble WASM inputs from the DB / UI, call WASM, reshape outputs into zod / React types. Do **not** reimplement costing, availability, unit conversion, parsing, or formatting in TS — call the WASM. (The old TS `calculateTotals` was deleted when the Rust costing engine landed; don't reintroduce that pattern.)

## Service vs. Direct Repo Boundary

A `*.service.ts` is warranted only when the orchestration is genuinely cross-cutting — USDA food enrichment (ingredient.service.ts, product.service.ts), WASM compute (recipe-costing.service.ts, availability.service.ts), multi-repo transactional side-effects (product-orchestration.service.ts), or a domain rollup a single repo can't own (location-valuation.service.ts, problems.service.ts). Otherwise router callbacks call repos directly. A service that would be an empty pass-through is still wrong — this rule keeps the boundary clear: services own domain enrichment/compute/rollups, repos own data access and transactions.

## Cloudflare Workers: clocks & WASM tracing

Two runtime traps that turned a WASM CPU leak into a "slow DB write" misdiagnosis — **distrust per-op timing logs on workerd**:

- **The workerd clock is frozen during synchronous CPU.** `performance.now()` / `Date.now()` advance only on I/O, never during pure-CPU execution — so a `performance.now()` delta around a synchronous block (a WASM call, a hot JS loop) reads ~0 and that CPU is silently charged to the **next awaited I/O**. A "slow query/write" in a log is often mis-attributed WASM/JS CPU. Localize CPU with the CF **CPU-time** metric (CPU ≈ wall ⇒ compute, not I/O-wait) or a sampling profile, not wall-clock deltas; to time a CPU block, flush the clock with a trivial awaited I/O (`SELECT 1`) right after it.
- **No active `tracing` subscriber at INFO on the WASM hot path.** recipebridge runs in a long-lived, reused isolate, so a global `wasm_tracing` subscriber at INFO + a `#[tracing::instrument]` on a per-call fn (it Debug-formats every arg, e.g. the whole `MeasureGraph`) accumulates unbounded and burns CPU that **grows per call** until it trips `cpu_ms`. Held at WARN on workerd in `recipebridge/src/lib.rs`; hot-path instruments must use `level = "trace", skip_all`.

## Required Helpers

Use these instead of inline patterns:

| Pattern to avoid                                           | Use instead                                     | Import from                                  |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Inline deletable config object                             | `useDeletableConfig({ ... })`                   | `~/app/_components/hooks/useDeletableConfig` |
| Inline update mutation with `useMemo` + `useMutation`      | `useUpdateMutation({ ... })`                    | `~/app/_components/hooks/useUpdateMutation`  |
| Inline `useMutation` + `toast` + `invalidateQueries`       | `useActionMutation({ ... })`                    | `~/app/_components/hooks/useActionMutation`  |
| `error instanceof Error ? error.message : "Unknown error"` | `getErrorMessage(error)`                        | `~/lib/error-utils`                          |
| Manual `.insert().values().returning()` + null check       | `insertAndReturn(db, table, values)`            | `~/server/repo/database-helpers`             |
| Manual `.update().set().where().returning()` + null check  | `updateAndReturn(db, table, values, where)`     | `~/server/repo/database-helpers`             |
| `getDb(db).transaction(async (tx) => {...})`               | `withTransaction(db, async (tx) => {...})`      | `~/server/repo/database-helpers`             |
| `ilike(column, \`%${term}%\`)`                             | `formatSearchTerm(column, term)`                | `~/server/repo/database-helpers`             |
| `isNull(table.deletedAt)`                                  | `notDeleted(table)`                             | `~/server/repo/database-helpers`             |
| Manual conditions array + notDeleted + formatSearchTerm    | `buildSearchConditions(table, filters, extras)` | `~/server/repo/database-helpers`             |
| `ComboboxItem.refine()` for required product               | `requiredProductField`                          | `~/app/_components/form-fields`              |
| `ComboboxItem.refine()` for required location              | `requiredLocationField`                         | `~/app/_components/form-fields`              |
| `as ProductId`, `as LocationId`, etc.                      | `unsafeProductId()`, `unsafeLocationId()`, etc. | `@cubby/schemas/identifiers`                 |
| Inline `["inventoryItem"]` query keys                      | `queryKeys.inventoryItem.list`                  | `~/lib/query-keys`                           |
| `Array.from(new Set(arr))` or `[...new Set(arr)]`          | `uniq(arr)` / `uniqBy(arr, fn)`                 | `es-toolkit`                                 |
| Hand-rolled `keyBy`/`groupBy`/`sumBy`/`partition`/`sum`    | the es-toolkit fn of the same name              | `es-toolkit`                                 |
| `switch`/`if`-ladder on a discriminated-union tag          | `match(x).with(...).exhaustive()`               | `ts-pattern`                                 |
| `value === "(unspecified)"`                                | `isUnspecifiedManufacturer(value)`              | `~/lib/manufacturer-utils`                   |
| Inline `{ a, b, source, sourceMetadata: { type: "manual" } }` edge | `manualUnitMapping(a, b, source?)`      | `@cubby/schemas/unitmapping`                 |
| `pMap(ids, (id) => getIngredientByID(...))` per-id loops    | `getIngredientsByIDs(db, usdaClient, ids)`      | `~/server/services/ingredient.service`       |

es-toolkit / ts-pattern caveats (don't over-apply): `keyBy` is for `Object.fromEntries(arr.map(...))` (Record→Record). Leave pure `Record<Enum, _>` value/theme lookups, `neverthrow` `.match()`, debounce/throttle (`@tanstack/react-pacer`), and date math (`date-fns`) as they are.

`useActionMutation` carve-outs (NOT drift — don't re-flag these as bypass sites): the helper's `success` is optional (omit it to skip the toast but keep invalidation + `watchBatchesAndInvalidate`), but its `invalidateKeys` are static per-hook and its `onError` is always a `toast.error`. So a raw `useMutation` is still correct when the site (a) shares one multi-mutation invalidator across several mutations (e.g. `background-jobs-page` retry/cancel/drain, `SessionCaptureActions`' `invalidateCapture`), (b) needs **conditional** invalidate keys the static list can't express (e.g. `background-jobs-page`'s `selectedBatchId`-gated key), (c) toasts from the caller via `mutateAsync` in try/catch (e.g. `location-validate-form`'s reparent), (d) surfaces errors inline (`setError`) instead of a toast (e.g. `bulk-reparent-locations-dialog`), or (e) does variables-driven `setState` in `onSuccess` (e.g. `InventorySessionWorkbench`'s `reconcile`).

`noUncheckedIndexedAccess` is ON repo-wide: `arr[i]`, `record[strKey]`, and `Map`-via-bracket all type as `T | undefined`, so guard or assert before use. Exceptions that stay `T`: `Record<FiniteEnum, V>[enumKey]` (finite-key Records aren't index signatures) and access right after a `.length`/membership check (assert with `!`). Don't silence a genuinely-reachable undefined with `!` — guard it; that's the bug the flag exists to catch.

## Opaque Database Type

The `Database` type is opaque (branded) — you can't call methods on it outside repo files. This enforces the layered architecture:

- **Routers** accept `Database`, pass it to repos or services
- **Services** accept `Database`, pass it to repos (can't query directly)
- **Repos** call `getDb(db)` to unwrap and access the actual DrizzleClient
- **Transactions** use `withTransaction(db, async (tx) => {...})` — `tx` is unwrapped and can be used directly

## Soft Delete

All major entities (products, recipes, locations, ingredients, inventory, projects, tasks, vendors, purchases, expenses) use soft delete with a `deletedAt` timestamp column. Deleted items are retained in the database but hidden from normal queries.

- Always use `notDeleted(table)` helper to filter out deleted records in queries
- **This applies *inside* `exists()` / `notExists()` subqueries too — guard-enforced.** A soft-deleted row still satisfies `EXISTS`, so `notExists(select().from(inventoryEntry).where(eq(...)))` reads as "has no inventory" but silently matches products whose inventory was merely emptied. Since emptying a shelf soft-deletes rather than removes, that's the *common* path: this exact omission made `findOrphanedProducts` miss 18 of 20 real hits (#428), and the same bug sat unnoticed in two more subqueries in the same file. `scripts/check-soft-delete-filters.mjs` (runs in `pnpm check`, so CI) fails any `exists`/`notExists` subquery over a soft-deletable table that has neither `notDeleted(…)` nor an explicit `deletedAt` predicate. For the rare subquery that genuinely must see deleted rows (cleanup/orphan sweeps), put an `includes-deleted: <reason>` comment above the call.
- Delete operations cascade to related entities (e.g., deleting a product soft-deletes its images and unit mappings)
- All deletions are wrapped in transactions and logged to audit trail
- Safety checks prevent deletion of entities with dependencies (e.g., products with inventory)
- **Restore functionality is intentionally not implemented** — treat soft deletes as permanent from a user perspective
- **Removal-path invariant**: every path that removes an entity (single delete, bulk delete/move, reconcile, hard-delete) must clean up its `EntityEmbedding` rows in the same transaction (`softDeleteEntityEmbeddingsTx`), and cost-affecting deletions must propagate staleness to dependents (e.g. deleting a sub-recipe marks/recomputes parent recipes via `dispatchRecompute(parentIds)`). Guarded by `findOrphanedEntityEmbeddings` (repo/entity-embedding.ts, exercised in `embedding-cascade-invariant.integration.test.ts`) and the `findParentRecipesWithDeletedSubRecipes` Problems detector — a new removal path that skips this is a bug, not a carve-out.
- **Incoming-edge invariant**: `apps/web/src/server/db/entity-incoming-edges.ts` is the schema-checked fact table of every FK that points at an entity. Every delete, merge, orphan detector, or other operation whose correctness depends on those references must declare an exhaustive `IncomingEdgePolicy<Entity, Disposition>` (or a stable role map such as `PRODUCT_EDGE_ROLES`) and keep a real-DB backstop for each disposition. Keep behavior operation-specific: the same `Expense.purchaseId` edge is cleared on purchase delete and re-pointed on purchase merge, so there is deliberately no global cascade/disposition on `INCOMING_EDGES`.

## Branded IDs

Use branded ID schemas from `@cubby/schemas/identifiers` (e.g., `locationId`, `productId`) instead of plain `z.string()`. This prevents mixing up entity IDs at compile time.

DB id columns are branded with `.$type<XxxId>()` in `schema.ts` (PKs + FK refs to core entities: recipe, ingredient, product, location, inventory, cookbook, user, project, task, vendor, purchase, expense), so Drizzle queries return branded ids **natively** — no cast needed when reading or writing entity ids. Relation reads inherit column brands, so nested `.id`s are branded too.

The `unsafe*Id()` / `unsafe*Shortcode()` converters are for genuine `string → brand` boundaries only: untyped external strings, synthetic ids (e.g. `"_root"`), and tests. They are **type-guarded** — passing an already-branded value is a compile error (the cast would be a no-op; brand it upstream instead). This is the lint rule (Biome has no custom-rule support at the pinned version, so the type system enforces it via `pnpm typecheck`).

Don't brand shortcode columns or `Image` ids — those add insert-side friction for negligible payoff; the `unsafe*Shortcode` casts at the repo boundary are the accepted pattern there. Route path params that feed branded sinks are branded at the route via `params.parse` (see `cookbooks.$cookbookId.tsx`); tRPC `getByID` inputs accept a plain string (a branded schema's input type is `string`), so most search-param ids need no cast at all.

## Mobile PWA

**Target: iOS only** — no Android-specific APIs (e.g., `navigator.vibrate` is not available on iOS Safari). The installable app shell and offline fallback are shipped; [the Mobile / PWA backlog](docs/todos.md#mobile--pwa) tracks the scanner UX and perf work that remains.

## apps/web UI conventions

React hook rules (render-loop traps, stable defaults, `useQueries` combine), design tokens, spacing, layout primitives, tables, and the page shell live in [apps/web/CLAUDE.md](apps/web/CLAUDE.md) — loaded automatically when working under that directory.
