# apps/web — UI conventions

Loaded when working under `apps/web`. Repo-wide rules live in the root [CLAUDE.md](../../CLAUDE.md).

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

- Never hardcode colors (hex/oklch) in components. Use the tokens in `apps/web/src/styles.css` — the warm chart ramp (`--chart-1..8`) and semantic tokens (`--plum`, `--positive`, `--warning`, …). Map green→`positive`, red→`destructive`, amber/yellow→`warning` (one tone — don't reintroduce a `text-amber-600/700/800` shade ladder). This is **enforced** by `scripts/check-conventions.mjs` (run via `pnpm check`); the only exempt surfaces are `design-gallery.tsx`/`design.tsx` (swatches), `IsometricPantry.tsx` (`<canvas>` paint), and `theme-color`/chart-lib fallbacks.
- A new semantic color gets a `--token` in `:root` **and** a `--color-*` mirror in `@theme inline` (the `--plum` / `--color-plum` pattern), so both `var(--token)` and Tailwind utilities (`text-foo`) work. e.g. `--ingredient-amount/name/modifier`. **Composite shadow/text-shadow tokens** (`--shadow-chunky*`, `--shadow-inset-gloss`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.
- **Density north star: McMaster-Carr, not a SaaS marketing site.** Crisp, high-information-density, technical. Separate with hairline rules (`border border-[var(--border)]`), not whitespace or airy floating cards. A dense repeated list is bordered rows, not a stack of padded `Card`s; reach for `Card` only for a genuinely bounded surface (the detail spec-plate, a titled panel), never as a per-row wrapper.
- **Text hierarchy is exactly 3 levels** — `text-foreground` (primary), `text-muted-foreground` (secondary), `text-slate` (mono micro-labels / eyebrows). Don't invent a 4th tier with opacity (`text-muted-foreground/70`, `text-foreground/60`): snap readable text to the nearest solid level. Semantic tones (`positive`/`warning`/`destructive`/`plum`/`primary`) are **not** hierarchy — leave them.
- **Icon sizes: `size-3.5` (14px) for inline/nav glyphs, `size-5` (20px) for card/tile/hero icons.** Use the `size-N` shorthand, never `h-N w-N` (guard-enforced, rule `hw-pair-shorthand`). Micro-indicators (sort arrows, dense badges) stay `size-3`; the interactive ui primitives (Button/DropdownMenu/Command/Tabs/Toggle) already default their icon slot to `size-3.5`, so an explicit size on a glyph inside them is an override — usually unwanted.
- **Badge is the canonical categorical chip** — a mono-uppercase stamp (`font-mono uppercase tracking-wider`, the default). Free-form prose in a badge (product names, user text) opts out with `font-sans normal-case tracking-normal`. Don't hand-roll pill styling.

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

## Entity names are always readable and always clickable

Every entity in `entities.tsx` has a detail route, so **a rendered entity name is never plain truncated text.** Two acceptable shapes:

- **`EntityInlineLink`** — links to the detail route and reveals the full name in its hover preview card. Every entity is previewable (`HoverPreviewEntity`); adding a `title` on top of it would just double up with the card.
- **A truncated span/link carrying `title={name}`** — for the surfaces `EntityInlineLink` doesn't fit (chart axis labels, tree rows, calendar chips). Link it too unless an ancestor `<a>` already owns the click (nested anchors are invalid — see the calendar `MealChip`) or the row genuinely carries no id (`ingredientAvailabilityOut`'s sub-recipe rows).

Inside an `<RTable>`, **use `createNameColumn`** — it bundles width + `truncate` + full-name `Tooltip` + `TableLink` to the detail route, plus optional inline rename. Hand-rolling `cell: ({row}) => row.original.name` is what made the project detail page's Task/Expense names unreadable and unreachable. `header` overrides the label for tables embedded under another entity ("Task", not "NAME"); `nameSuffix` carries any secondary affordance (e.g. an expense's external vendor link) without stealing the name's own click.

An embedded table must also reach **its own** rows' entity, not just their relations — `location-inventory-table` links product and location on every row, so the amount cell carries the `/inventory/$id` link (`renderDisplay`).

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/components/page/Page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. List = eyebrow/title/actions/accent header; detail = the spec-plate placard. Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/app/_components/data-table/detail-page`) as `Page`'s children.
