[README.md](README.md) is the canonical source of truth for the project — architecture, monorepo layout, deploy targets, commands, entities, environment, and the roadmap. Read it first. This file contains only rules and anti-patterns for the Claude agent. When you need context that isn't a rule, go to README rather than embedding the answer here.

## Where logic lives (layering)

Three layers, one rule: never recompute in a higher layer what a lower one already owns.

- **`ingredient-parser` crates** (`ingredient`, `recipe-scraper`, `recipe-epub`, `recipe-types`) — pure ingredient / unit / recipe-shape logic, with **no** cubby-domain concepts (products, USDA `fdc_id`, prices, inventory, nutrient codes). Shared by `recipebridge` (WASM) **and** the native tools (food-cli / food-app). The deps-light contract.
- **`recipebridge`** (cubby's WASM crate) — cubby-domain compute (recipe costing, availability evaluation, food-mapping synthesis from products + USDA) plus the WASM boundary (`W*` tsify types, serde-wasm-bindgen marshalling). The single source of truth for those engines, consumed by the browser **and** the server (`*.service.ts`) via WASM. **Do not move these engines into `ingredient-parser`** — they're application domain with no upstream consumer; that's a layering violation, not consolidation. (Pure, generic unit helpers with no cubby coupling are the *only* thing that may migrate down — see the TODO in `recipebridge/src/reconcile.rs`.)
- **TS (`apps/web`)** — a thin boundary: assemble WASM inputs from the DB / UI, call WASM, reshape outputs into zod / React types. Do **not** reimplement costing, availability, unit conversion, parsing, or formatting in TS — call the WASM. (The old TS `calculateTotals` was deleted when the Rust costing engine landed; don't reintroduce that pattern.)

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
| `ComboboxItem.refine()` for required product               | `requiredProductField`                          | `~/schemas/form-fields`                      |
| `ComboboxItem.refine()` for required location              | `requiredLocationField`                         | `~/schemas/form-fields`                      |
| `as ProductId`, `as LocationId`, etc.                      | `unsafeProductId()`, `unsafeLocationId()`, etc. | `~/schemas/identifiers`                      |
| Inline `["inventoryItem"]` query keys                      | `queryKeys.inventoryItem.list`                  | `~/lib/query-keys`                           |
| `Array.from(new Set(arr))` or `[...new Set(arr)]`          | `uniq(arr)` / `uniqBy(arr, fn)`                 | `es-toolkit`                                 |
| Hand-rolled `keyBy`/`groupBy`/`sumBy`/`partition`/`sum`    | the es-toolkit fn of the same name              | `es-toolkit`                                 |
| `switch`/`if`-ladder on a discriminated-union tag          | `match(x).with(...).exhaustive()`               | `ts-pattern`                                 |
| `value === "(unspecified)"`                                | `isUnspecifiedManufacturer(value)`              | `~/lib/manufacturer-utils`                   |
| Inline `{ a, b, source, sourceMetadata: { type: "manual" } }` edge | `manualUnitMapping(a, b, source?)`      | `@cubby/schemas/unitmapping`                 |

es-toolkit / ts-pattern caveats (don't over-apply): `keyBy` is for `Object.fromEntries(arr.map(...))` (Record→Record). Leave pure `Record<Enum, _>` value/theme lookups, `neverthrow` `.match()`, debounce/throttle (`@tanstack/react-pacer`), and date math (`date-fns`) as they are.

`noUncheckedIndexedAccess` is ON repo-wide: `arr[i]`, `record[strKey]`, and `Map`-via-bracket all type as `T | undefined`, so guard or assert before use. Exceptions that stay `T`: `Record<FiniteEnum, V>[enumKey]` (finite-key Records aren't index signatures) and access right after a `.length`/membership check (assert with `!`). Don't silence a genuinely-reachable undefined with `!` — guard it; that's the bug the flag exists to catch.

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

This pattern is built into `useEntityList` — no additional code needed for list pages. Items disappear instantly when deleted, providing excellent UX while maintaining data integrity.

## Opaque Database Type

The `Database` type is opaque (branded) — you can't call methods on it outside repo files. This enforces the layered architecture:

- **Routers** accept `Database`, pass it to repos or services
- **Services** accept `Database`, pass it to repos (can't query directly)
- **Repos** call `getDb(db)` to unwrap and access the actual DrizzleClient
- **Transactions** use `withTransaction(db, async (tx) => {...})` — `tx` is unwrapped and can be used directly

## Soft Delete

All major entities (products, recipes, locations, ingredients, inventory) use soft delete with a `deletedAt` timestamp column. Deleted items are retained in the database but hidden from normal queries.

- Always use `notDeleted(table)` helper to filter out deleted records in queries
- Delete operations cascade to related entities (e.g., deleting a product soft-deletes its images and unit mappings)
- All deletions are wrapped in transactions and logged to audit trail
- Safety checks prevent deletion of entities with dependencies (e.g., products with inventory)
- **Restore functionality is intentionally not implemented** — treat soft deletes as permanent from a user perspective

## Branded IDs

Use branded ID schemas from `~/schemas/identifiers` (e.g., `locationId`, `productId`) instead of plain `z.string()`. This prevents mixing up entity IDs at compile time.

DB id columns are branded with `.$type<XxxId>()` in `schema.ts` (PKs + FK refs to core entities: recipe, ingredient, product, location, inventory, cookbook, user), so Drizzle queries return branded ids **natively** — no cast needed when reading or writing entity ids. Relation reads inherit column brands, so nested `.id`s are branded too.

The `unsafe*Id()` / `unsafe*Shortcode()` converters are for genuine `string → brand` boundaries only: untyped external strings, synthetic ids (e.g. `"_root"`), and tests. They are **type-guarded** — passing an already-branded value is a compile error (the cast would be a no-op; brand it upstream instead). This is the lint rule (Biome has no custom-rule support at the pinned version, so the type system enforces it via `pnpm typecheck`).

Don't brand shortcode columns or `Image` ids — those add insert-side friction for negligible payoff; the `unsafe*Shortcode` casts at the repo boundary are the accepted pattern there. Route path params that feed branded sinks are branded at the route via `params.parse` (see `cookbooks.$cookbookId.tsx`); tRPC `getByID` inputs accept a plain string (a branded schema's input type is `string`), so most search-param ids need no cast at all.

## Mobile PWA

**Target: iOS only** — no Android-specific APIs (e.g., `navigator.vibrate` is not available on iOS Safari). For design details, follow the Mobile PWA roadmap pointer in [README.md](README.md).

## Colors / Design Tokens

- Never hardcode colors (hex/oklch) in components. Use the tokens in `apps/web/src/styles.css` — the warm chart ramp (`--chart-1..8`) and semantic tokens (`--plum`, `--positive`, `--warning`, …). Map green→`positive`, red→`destructive`, amber/yellow→`warning` (one tone — don't reintroduce a `text-amber-600/700/800` shade ladder). This is **enforced** by `scripts/check-conventions.mjs` (run via `pnpm check`); the only exempt surfaces are `design-gallery.tsx`/`design.tsx` (swatches), `IsometricPantry.tsx` (`<canvas>` paint), and `theme-color`/chart-lib fallbacks.
- A new semantic color gets a `--token` in `:root` **and** a `--color-*` mirror in `@theme inline` (the `--plum` / `--color-plum` pattern), so both `var(--token)` and Tailwind utilities (`text-foo`) work. e.g. `--ingredient-amount/name/modifier`. **Composite shadow/text-shadow tokens** (`--shadow-chunky*`, `--shadow-inset-gloss`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.

## Spacing

- **Strict `{1,2,4,6}` scale, guard-enforced.** All `gap`/`space-x|y`/`p*`/`m*` spacing must use `0,1,2,4,6` (Tailwind units; `--spacing` 0.25rem). Off-scale values (`gap-3`, `space-y-3`, `p-1.5`, `py-2.5`, `m-5`, …) FAIL `scripts/check-conventions.mjs` (runs in `pnpm check`). Named keys `xs/sm/md/lg` on the layout cvas in `apps/web/src/styles/layouts.ts` map to `1/2/4/6`.
- **Exemptions:** `components/ui/**` (shadcn primitives — their `px-3`/`p-6` is the design system's own component padding), the `/design` gallery, and any line with an inline `/* tight */` comment (genuinely dense UI — calendars, icon nudges, nav-clearance negatives). Use `/* tight */` sparingly; default is to round to scale.
- `gap-*` for flex/grid containers (siblings laid out by the parent); `space-y-*` only for plain block stacks with no flex/grid context.

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/components/page/Page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. List = eyebrow/title/actions/accent header; detail = the spec-plate placard. Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/app/_components/data-table/detail-page`) as `Page`'s children.
