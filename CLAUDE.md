[README.md](README.md) is the canonical source of truth for the project — architecture, monorepo layout, deploy targets, commands, entities, environment, and the roadmap. Read it first. This file contains only rules and anti-patterns for the Claude agent. When you need context that isn't a rule, go to README rather than embedding the answer here.

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
- **Removal-path invariant**: every path that removes an entity (single delete, bulk delete/move, reconcile, hard-delete) must clean up its `EntityEmbedding` rows in the same transaction (`softDeleteEntityEmbeddingsTx`), and cost-affecting deletions must propagate staleness to dependents (e.g. deleting a sub-recipe marks/recomputes parent recipes via `dispatchRecompute(parentIds)`). Guarded by `findOrphanedEntityEmbeddings` (repo/entity-embedding.ts, exercised in `embedding-cascade-invariant.integration.test.ts`) and the `findParentRecipesWithDeletedSubRecipes` Problems detector — a new removal path that skips this is a bug, not a carve-out.

## Branded IDs

Use branded ID schemas from `@cubby/schemas/identifiers` (e.g., `locationId`, `productId`) instead of plain `z.string()`. This prevents mixing up entity IDs at compile time.

DB id columns are branded with `.$type<XxxId>()` in `schema.ts` (PKs + FK refs to core entities: recipe, ingredient, product, location, inventory, cookbook, user), so Drizzle queries return branded ids **natively** — no cast needed when reading or writing entity ids. Relation reads inherit column brands, so nested `.id`s are branded too.

The `unsafe*Id()` / `unsafe*Shortcode()` converters are for genuine `string → brand` boundaries only: untyped external strings, synthetic ids (e.g. `"_root"`), and tests. They are **type-guarded** — passing an already-branded value is a compile error (the cast would be a no-op; brand it upstream instead). This is the lint rule (Biome has no custom-rule support at the pinned version, so the type system enforces it via `pnpm typecheck`).

Don't brand shortcode columns or `Image` ids — those add insert-side friction for negligible payoff; the `unsafe*Shortcode` casts at the repo boundary are the accepted pattern there. Route path params that feed branded sinks are branded at the route via `params.parse` (see `cookbooks.$cookbookId.tsx`); tRPC `getByID` inputs accept a plain string (a branded schema's input type is `string`), so most search-param ids need no cast at all.

## Mobile PWA

**Target: iOS only** — no Android-specific APIs (e.g., `navigator.vibrate` is not available on iOS Safari). For design details, follow the Mobile PWA roadmap pointer in [README.md](README.md).

## Colors / Design Tokens

- Never hardcode colors (hex/oklch) in components. Use the tokens in `apps/web/src/styles.css` — the warm chart ramp (`--chart-1..8`) and semantic tokens (`--plum`, `--positive`, `--warning`, …). Map green→`positive`, red→`destructive`, amber/yellow→`warning` (one tone — don't reintroduce a `text-amber-600/700/800` shade ladder). This is **enforced** by `scripts/check-conventions.mjs` (run via `pnpm check`); the only exempt surfaces are `design-gallery.tsx`/`design.tsx` (swatches), `IsometricPantry.tsx` (`<canvas>` paint), and `theme-color`/chart-lib fallbacks.
- A new semantic color gets a `--token` in `:root` **and** a `--color-*` mirror in `@theme inline` (the `--plum` / `--color-plum` pattern), so both `var(--token)` and Tailwind utilities (`text-foo`) work. e.g. `--ingredient-amount/name/modifier`. **Composite shadow/text-shadow tokens** (`--shadow-chunky*`, `--shadow-inset-gloss`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.

## Spacing

- **Guard-enforced scale.** `gap`/`space-x|y`/`p*`/`m*` use the doublings `{0,1,2,4,6}` plus the legit large steps `{8,12,16,20}` (wide gutters, big touch targets, hero/clearance padding). The odd/half **rhythm drift** (`1.5, 2.5, 3, 5, 7, 9, 10, 11, 13, 14`) FAILS `scripts/check-conventions.mjs` (runs in `pnpm check`) — that's the long tail we killed. Named keys `xs/sm/md/lg` on the layout cvas in `apps/web/src/styles/layouts.ts` map to `1/2/4/6`.
- **Exemptions:** `components/ui/**` (shadcn primitives — their `px-3` etc. is the design system's own component padding), the `/design` gallery, and the rare genuinely-dense sub-scale spot (`gap-0.5` optical nudges, dense calendar cells) marked with an inline `/* tight */`. Use `/* tight */` sparingly — and prefer encapsulating density in a component over scattering the marker.
- `gap-*` for flex/grid containers (siblings laid out by the parent); `space-y-*` only for plain block stacks with no flex/grid context.

## Layout primitives

- **Pages defer to the layout primitives, not raw flex/grid/space-y Tailwind.** Import `Row` / `Stack` / `Grid` / `Section` from `~/components/layout` (cvas in `apps/web/src/styles/layouts.ts`):
  - **`Stack`** — vertical block stack (`space-y-*` under the hood). `gap`: `tight(0.5) | snug(1.5) | xs(1) | sm(2) | md(4, default) | lg(6)`. Replaces `<div className="space-y-N">`.
  - **`Row`** — horizontal flex. No defaults (a bare `<Row>` is just `flex`). `align` (start/center/end/baseline/stretch), `justify` (start/center/end/between/around), `wrap`, same `gap` scale. Replaces `flex items-center gap-N` (± `justify-between`).
  - **`Grid`** — `cols` presets `cards3 | thumbs | images | summary` + `gap`. Non-preset/custom `grid-cols-[…]` stay raw.
  - **`Section`** — semantic `<section>` with an optional `title`/`description` header (`h2` heading typography, fixed `gap="md"`) over a `Stack` body. Use for a titled page region; use `Card` when it needs a bordered surface.
  - `Row`/`Stack`/`Grid` are polymorphic via `as` (`as="ul"/"li"/"form"/"button"`; `Row`/`Stack` also take `type`/`disabled` for `as="button"`). They do **not** accept `href`/router props — leave `<a>`/`<Link>` raw. (`Section` always renders a `<section>`.)
- **Sub-scale density lives in the `gap="tight"/"snug"` variants** (defined in `layouts.ts`, a `.ts` the spacing guard doesn't scan) — so dense UI needs no `/* tight */` marker. The marker now only covers genuine sub-scale **padding/margin** (no primitive prop for it).
- **Bar for reaching for a primitive:** the layout repeats or encodes a real decision — don't wrap a lone one-off `<div className="flex">`, a `flex flex-col` column, a responsive `flex-col sm:flex-row` switch, an `inline-flex`, or a className on a shadcn primitive. Keep sizing (`h/w/flex-1/shrink-0`), color, position, `rounded/shadow`, and typography inline via the primitive's `className`.

## Tables

Three layers — pick by what the surface is, never hand-roll table styling:

- **`<RTable>`** (`~/app/_components/data-table/Table`) — the TanStack orchestrator for an **interactive list**: sortable / filterable / paginated / selectable rows, mobile cards, grouping. Big CRUD list pages.
- **`<Table>` primitives** (`Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` from `~/components/ui/table`) — for **static tabular data** embedded in a page/panel (`<RTable>` would be overkill). Don't re-implement `border-collapse` + inline `border-b`/`py-1 pr-2` cell padding; the primitives own borders, padding, hover, and the uppercase-mono eyebrow header (`<TableHead>`). `<Table>` is **pure styling over native `<table>`** — it does no row-modeling, so `rowSpan`/`colSpan` and nested/grouped rows pass straight through.
  - Two defaults are tuned for `<RTable>`'s explicitly-sized columns: `<Table>` is **`table-fixed`** and `<TableCell>` is **`whitespace-nowrap`**. For content-sized columns pass `className="table-auto"`; for wrapping prose cells add `whitespace-normal`. Suppress an unwanted row divider with `border-b-0` (e.g. grouped/`rowSpan` clusters). Keep the bordered-card wrapper via `containerClassName`.
- **Raw `<table>`** only when those defaults actively fight the layout: **matrices / cross-tabs** (entities as columns, sticky panes, per-cell heatmap/stat styling — e.g. `RecipeCompareGrid`, `IngredientComponentGrid`), **dev/debug-only** surfaces (`perf-overlay`, costing-debug card), and **external-content** rendering (`markdown.tsx`).

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/components/page/Page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. List = eyebrow/title/actions/accent header; detail = the spec-plate placard. Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/app/_components/data-table/detail-page`) as `Page`'s children.
