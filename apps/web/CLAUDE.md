# apps/web — UI conventions

Loaded when working under `apps/web`. Repo-wide rules live in the root [CLAUDE.md](../../CLAUDE.md).

Visual intent, named design rules, palette roles, typography, shape language, and component character live in [DESIGN.md](DESIGN.md). This file keeps implementation contracts, guard-enforced conventions, and failure-prevention guidance; do not duplicate visual philosophy here.

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

### Stable defaults for hook results (guard-enforced)

Never use an inline fresh-object default when destructuring a hook result — `const { data = [] } = useQuery(...)`. While the value is `undefined` (query **loading or disabled**, e.g. an `enabled: codes.length > 0` query with no codes), the default allocates a **new reference every render**, destabilizing every `useMemo`/`useEffect` keyed on it downstream — if any of those effects set state, that's an infinite render loop (this froze the labels page). It also hides in testing: when both queries have real data, react-query's structural sharing keeps references stable and the loop never starts.

```typescript
// Bad — new [] reference every render while data is undefined:
const { data: tags = [] } = useQuery(api.recipe.getAllTags.queryOptions());

// Good — module-level stable constant:
const NO_TAGS: string[] = [];
const { data: tags = NO_TAGS } = useQuery(api.recipe.getAllTags.queryOptions());
```

Enforced by `scripts/check-conventions.mjs` (`unstable-hook-default`, runs in `pnpm check`) for `= []`, `= {}`, and `= new X(...)` defaults on any `use*()` result destructure.

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

## Colors / Design Tokens

- Never hardcode colors (hex/oklch) in components. Use the tokens in `apps/web/src/styles.css` — the chart ramp (`--chart-1..8`) and semantic tokens (`--plum`, `--positive`, `--warning`, …). Map green→`positive`, red→`destructive`, amber/yellow→`warning`. This is **enforced** by `scripts/check-conventions.mjs` (run via `pnpm check`); the only exemptions are `IsometricPantry.tsx` (`<canvas>` paint) and `theme-color`/chart-lib fallbacks.
- A new semantic color gets a `--token` in `:root` **and** a `--color-*` mirror in `@theme inline` (the `--plum` / `--color-plum` pattern), so both `var(--token)` and Tailwind utilities (`text-foo`) work. e.g. `--ingredient-amount/name/modifier`. **Composite shadow/text-shadow tokens** (`--shadow-chunky*`, `--shadow-inset-gloss`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.
- **Icon sizes: `size-3.5` (14px) for inline/nav glyphs, `size-5` (20px) for card/tile/hero icons.** Use the `size-N` shorthand, never `h-N w-N` (guard-enforced, rule `hw-pair-shorthand`). Micro-indicators (sort arrows, dense badges) stay `size-3`; the interactive ui primitives (Button/DropdownMenu/Command/Tabs/Toggle) already default their icon slot to `size-3.5`, so an explicit size on a glyph inside them is an override — usually unwanted.
- **Badge is the canonical categorical chip** — a mono-uppercase stamp (`font-mono uppercase tracking-wider`, the default). Free-form prose in a badge (product names, user text) opts out with `font-sans normal-case tracking-normal`. Don't hand-roll pill styling.

## Images

- **Every `<Image>` declares its rendered width.** The Cloudflare Image Transformation in `~/lib/image-url` is opt-in per call site — omit `displayWidth` and `<Image>` serves the full-size R2 original into whatever box the className sets. That's how the locations gallery pulled **1.8 MB** location photos into **32px** tiles while the 240px hover preview above them was correctly transformed. Pass the rendered CSS width; the helper never upscales (`fit=scale-down`) and emits a 1x/2x `srcSet`, so retina is already covered. Guard-enforced by `scripts/check-conventions.mjs` (`untransformed-image`, runs in `pnpm check`).
- Passing `displayWidth` for a non-bucket URL (external UPC-lookup images, data URLs) is a **harmless no-op** — `transformedImageUrl` returns the input unchanged. That's why the rule has no allowlist: there's never a reason not to declare the width.
- Prefer the wrappers over a bare `<Image>`: `ImageWithPreview` (defaults `displayWidth` to its `size`), `CardThumbnail`, `ImageThumbnail`, `InteractiveImage`. Only reach for `<Image>` directly when none of those fit.

## Spacing

- **Guard-enforced scale.** `gap`/`space-x|y`/`p*`/`m*` use the doublings `{0,1,2,4,6}` plus the legit large steps `{8,12,16,20}` (wide gutters, big touch targets, hero/clearance padding). The odd/half **rhythm drift** (`1.5, 2.5, 3, 5, 7, 9, 10, 11, 13, 14`) FAILS `scripts/check-conventions.mjs` (runs in `pnpm check`) — that's the long tail we killed. Named keys `xs/sm/md/lg` on the layout cvas in `apps/web/src/styles/layouts.ts` map to `1/2/4/6`.
- **Exemptions:** `components/ui/**` (shadcn primitives — their `px-3` etc. is the design system's own component padding) and the rare genuinely-dense sub-scale spot (`gap-0.5` optical nudges, dense calendar cells) marked with an inline `/* tight */`. Use `/* tight */` sparingly — and prefer encapsulating density in a component over scattering the marker.
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

### Column widths

- **`useCubbyTableLayout` owns order, pinning, visibility, and sizing** behind one `table-layout:v1:{layoutKey}` contract. `layoutKey` defaults to the entity; give embedded/specialized tables a distinct stable key. Do not add separate visibility or sizing stores.
- **Widths are TanStack numeric `size` / `minSize` / `maxSize` values.** The table platform publishes matching CSS width variables for header, body, footer, sticky offsets, native resize, and persistence. Tailwind width classes on `meta.className` are legacy input only and are normalized at the platform boundary.
- **Select and Image are structural leading columns.** When present, layout normalization keeps them visible, start-pinned, and first/second; their definitions disable pinning, hiding, cell selection, and reorder handles. Actions remains movable and pinnable but non-hideable.
- Keep the trailing gutter cell at `w-0`; declared numeric widths own the rendered geometry and overflow scrolls horizontally when the table is wider than its container.

## Entity names are always readable and always clickable

Every entity in `entities.tsx` has a detail route, so **a rendered entity name is never plain truncated text.** Two acceptable shapes:

- **`EntityInlineLink`** — links to the detail route and reveals the full name in its hover preview card. Use it for any entity in `HoverPreviewEntity`; adding a `title` on top of it would just double up with the card. Not every entity is previewable — `wish`, `financialAccount`, `financialTransaction`, and `image` have no `EntityInlineLink` case and no hover card, so a name for one of them needs the plain-link shape below instead.
- **A truncated span/link carrying `title={name}`** — for the surfaces `EntityInlineLink` doesn't fit (chart axis labels, tree rows, calendar chips). Link it too unless an ancestor `<a>` already owns the click (nested anchors are invalid — see the calendar `MealChip`) or the row genuinely carries no id (`ingredientAvailabilityOut`'s sub-recipe rows).

Inside an `<RTable>`, **use `createNameColumn`** — it bundles width + `truncate` + full-name `Tooltip` + `TableLink` to the detail route, plus optional inline rename. Hand-rolling `cell: ({row}) => row.original.name` is what made the project detail page's Task/Expense names unreadable and unreachable. `header` overrides the label for tables embedded under another entity ("Task", not "NAME"); `nameSuffix` carries any secondary affordance (e.g. an expense's external vendor link) without stealing the name's own click.

An embedded table must also reach **its own** rows' entity, not just their relations — `location-inventory-table` links product and location on every row, so the amount cell carries the `/inventory/$id` link (`renderDisplay`).

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/components/page/Page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. List = eyebrow/title/actions/accent header; detail = the spec-plate placard. Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/app/_components/data-table/detail-page`) as `Page`'s children.

## SSR and the tRPC transport

**The server render never makes an HTTP request to itself.** `trpc-transport-isomorphic.ts` picks the transport per environment via `createIsomorphicFn()`: the browser gets the batched HTTP links, and the server render gets `unstable_localLink` over `domainRouter` (`trpc-transport-server.ts`), which keeps the whole tRPC pipeline — context, auth middleware, output validation, SuperJSON — while skipping the hop. `getRequest()` reads from AsyncLocalStorage, so the module-scoped link still resolves the current request's headers and SSR queries run *authenticated*.

This is load-bearing, and the failure it prevents is nasty. The old shared client resolved `getUrl()` to `http://localhost:${PORT}/api/trpc` on the server: unauthenticated in dev, and on CF Workers never reaching the app at all — the edge answers with the plain-text body `error code: 1003`, so the response fails to parse and `Unexpected token 'e', "error code: 1003" is not valid JSON` lands in the route error boundary. It only fired on a **direct load** (client-side navigation skips SSR), which is how `/locations/arrange` shipped broken (#703).

Consequences for route authors:

- **`ssr: false` is now a cost decision, not a correctness one.** A route that suspends on a tRPC query renders fine on the server; the question is only whether you want to pay for it. Two routes opt out, each saying why in a comment: `/locations/arrange` dehydrates the whole location forest (844 KB of HTML against 84 KB client-only), and `/usda/$id` blocks on an upstream service binding whose work runs ~500ms-1s. Typical routes land at 80-150 KB and should stay server-rendered.
- **The Start plugin's strip is what keeps the server router out of the browser.** Don't import `trpc-transport-server` (or anything under `~/server`) from shared client code except through the `.server()` branch of an isomorphic fn. `assertNoServerCodeInClient` in `scripts/analyze-client-bundle.ts` fails `build:cf` if a client asset contains any `SERVER_ONLY_MARKERS` entry; the string literals there (`"No procedure found on path"`, `drizzle-orm`, `HYPERDRIVE`) are the teeth, since a minifier can rename a binding like `unstable_localLink` but not a literal.
- **A loader may now `await ensureQueryData(...)`** for a tRPC query. The old rule (`void prefetchQuery` only, never await) existed solely because the awaited self-fetch threw; it no longer applies. Awaiting blocks the render on that query, so it is still a latency choice.
