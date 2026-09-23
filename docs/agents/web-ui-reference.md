# Web UI rule reference

This preserves the detailed former web guidance. Load the relevant heading for the surface being changed; DESIGN.md is required only for UI or visual decisions.

## React Hooks: Preventing Infinite Render Loops

**CRITICAL**: Never pass inline object literals, arrays, or functions to hooks with dependencies. This creates new references on every render, triggering infinite loops.

### Bad (causes infinite re-renders):

```typescript
const { table } = useEntityList({
  deletable: {
    mutationOptions: (callbacks) =>
      api.product.delete.mutationOptions(callbacks),
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

Review hook defaults for `= []`, `= {}`, and `= new X(...)`; keep stable empty
values at module scope or memoize them.

### `useQueries` must use `combine`

`useQueries` returns a **new array reference on every render**. Deriving values from the raw result array (even inside `useMemo`) creates an unstable dependency chain that causes infinite re-renders when downstream `useEffect`s set state.

**Always** use the `combine` option, which applies structural sharing to keep the result referentially stable:

```typescript
// Bad — raw useQueries returns new array every render:
const queries = useQueries({ queries: queryOptions });
const data = useMemo(
  () => queries.map((q) => q.data).filter(Boolean),
  [queries],
); // ← new ref every render

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

- Avoid hardcoded colors (hex/oklch) in components. Shared palette and semantic primitives (`--positive`, `--warning`, `--destructive`, …) live in `packages/design-tokens/brand.css`; web-only derivations such as the chart ramp (`--chart-1..8`) live in `apps/web/src/styles.css`. Map green→`positive`, red→`destructive`, amber/yellow→`warning`. Canvas paint, `theme-color`, and chart-library fallbacks are the usual exceptions; this is a design-review rule rather than a CI regex.
- Add a shared semantic primitive in `packages/design-tokens/brand.css`; add its `--color-*` mirror in `apps/web/src/styles.css`'s `@theme inline` when Tailwind utilities (`text-foo`) need it. A genuinely web-only token starts in `styles.css`. **Composite shadow/text-shadow tokens** (`--shadow-chunky*`, `--shadow-inset-gloss`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.
- **Icon sizes: `size-3.5` (14px) for inline/nav glyphs, `size-5` (20px) for card/tile/hero icons.** Use the `size-N` shorthand, never `h-N w-N` (guard-enforced, rule `hw-pair-shorthand`). Micro-indicators (sort arrows, dense badges) stay `size-3`; the interactive ui primitives (Button/DropdownMenu/Command/Tabs/Toggle) already default their icon slot to `size-3.5`, so an explicit size on a glyph inside them is an override — usually unwanted.
- **Badge is the canonical categorical chip.** Sentence case is the default; use monospaced uppercase treatment explicitly for short codes or register labels. Don't hand-roll pill styling.

## Images

- **Every `<Image>` declares its rendered CSS width (`displayWidth`) or explicitly opts out with `unoptimized`.** The `ImageProps` union enforces this at typecheck. Declare the box's real width — never a transform size: `transformedImageUrl` (`src/lib/image-url.ts`) requests 2× the rendered width and snaps up to one of three rungs (`IMAGE_WIDTHS` = 128 / 640 / 2048), so every small placement of a photo shares one URL, one cache entry and one billed transformation. There is no `srcSet`; the 2× request covers retina. The native app mints identical URLs (`CubbyKit/Media/ImageTransform.swift`) — change the ladder in both places or not at all.
- Passing `displayWidth` for a non-bucket URL (external UPC-lookup images, data URLs) is a **harmless no-op** — `transformedImageUrl` returns the input unchanged. That's why the rule has no allowlist: there's never a reason not to declare the width.
- Prefer the wrappers over a bare `<Image>`: `ImageWithPreview` (defaults `displayWidth` to its `size`), `CardThumbnail`, `ImageThumbnail`. Only reach for `<Image>` directly when none of those fit. Every hover preview renders at `PREVIEW_PX` (`ImagePreviewPopup`); don't mint a per-surface preview size.
- List thumbnails come from the row's server-resolved `displayImages` (`createImageColumn` reads it; no per-list `getImages` rule) — see the entity-display-image policy in `server/repo/entity-display-image.ts`.

## Spacing

- **Spacing scale.** `gap`/`space-x|y`/`p*`/`m*` normally use `{0,1,2,4,6}` plus `{8,12,16,20}` for wide gutters, touch targets, and large clearance. Named keys `xs/sm/md/lg` on the layout cvas in `apps/web/src/styles/layouts.ts` map to `1/2/4/6`. Treat deviations as a visual-review decision, not a CI regex violation.
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

- **`EntityInlineLink`** — links to the detail route and reveals the full name in its hover preview card. Use it for any entity in `HoverPreviewEntity`; adding a `title` on top of it would just double up with the card. Pass each entity's real title field (`displayName` for financial transactions and `filename` for images), rather than inventing a generic `name`.
- **A truncated span/link carrying `title={name}`** — for the surfaces `EntityInlineLink` doesn't fit (chart axis labels, tree rows, calendar chips). Link it too unless an ancestor `<a>` already owns the click (nested anchors are invalid — see the calendar `MealChip`) or the row genuinely carries no id (`ingredientAvailabilityOut`'s sub-recipe rows).

Inside an `<RTable>`, **use `createNameColumn`** — it bundles width + `truncate` + full-name `Tooltip` + `TableLink` to the detail route, plus optional inline rename. Hand-rolling `cell: ({row}) => row.original.name` is what made the project detail page's Task/Expense names unreadable and unreachable. `header` overrides the label for tables embedded under another entity ("Task", not "NAME"); `nameSuffix` carries any secondary affordance (e.g. an expense's external vendor link) without stealing the name's own click.

An embedded table must also reach **its own** rows' entity, not just their relations — `location-inventory-table` links product and location on every row, so the amount cell carries the `/inventory/$id` link (`renderDisplay`).

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/components/page/Page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. List = eyebrow/title/actions/accent header; detail = the spec-plate placard. Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/app/_components/data-table/detail-page`) as `Page`'s children.
