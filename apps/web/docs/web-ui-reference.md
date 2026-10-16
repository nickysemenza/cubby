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
- Add a shared semantic primitive in `packages/design-tokens/brand.css`; add its `--color-*` mirror in `apps/web/src/styles.css`'s `@theme inline` when Tailwind utilities (`text-foo`) need it. A genuinely web-only token starts in `styles.css`. **Composite shadow/text-shadow tokens** (`--shadow-overlay`, `--shadow-pin-*`, `--shadow-scan-flash`, `--text-shadow-chart`) need **no** `@theme` mirror — use via `shadow-[var(--token)]` or `style={{ boxShadow: "var(--token)" }}`. Don't inline `rgba()` shadows in components; add a token.
- **Icon sizes: `size-3.5` (14px) for inline/nav glyphs, `size-5` (20px) for card/tile/hero icons.** Use the `size-N` shorthand, never `h-N w-N` (guard-enforced, rule `hw-pair-shorthand`). Micro-indicators (sort arrows, dense badges) stay `size-3`; the interactive ui primitives (Button/DropdownMenu/Command/Tabs/Toggle) already default their icon slot to `size-3.5`, so an explicit size on a glyph inside them is an override — usually unwanted.
- **Badge is the canonical categorical chip.** Sentence case is the default; use monospaced uppercase treatment explicitly for short codes or register labels. Don't hand-roll pill styling.

## Images

- **Every `<Image>` declares its rendered CSS width (`displayWidth`) or explicitly opts out with `unoptimized`.** The `ImageProps` union enforces this at typecheck. Declare the box's real width — never a transform size: `transformedImageUrl` (`src/lib/image-url.ts`) requests 2× the rendered width and snaps up to one of three rungs (`IMAGE_WIDTHS` = 128 / 640 / 2048), so every small placement of a photo shares one URL, one cache entry and one billed transformation. There is no `srcSet`; the 2× request covers retina. The native app mints identical URLs (`CubbyKit/Media/ImageTransform.swift`) — change the ladder in both places or not at all.
- Passing `displayWidth` for a non-bucket URL (external UPC-lookup images, data URLs) is a **harmless no-op** — `transformedImageUrl` returns the input unchanged. That's why the rule has no allowlist: there's never a reason not to declare the width.
- Prefer the wrappers over a bare `<Image>`: `ImageWithPreview` (defaults `displayWidth` to its `size`), `EntityCover`, `ImageThumbnail`. Only reach for `<Image>` directly when none of those fit. Every hover preview renders at `PREVIEW_PX` (`ImagePreviewPopup`); don't mint a per-surface preview size.
- List thumbnails come from the row's server-resolved `displayImages` (`createImageColumn` reads it; no per-list `getImages` rule) — see the entity-display-image policy in `server/entity-kernel/repo/entity-display-image.ts`.

## Spacing

- **Spacing scale.** `gap`/`space-x|y`/`p*`/`m*` normally use `{0,1,2,4,6}` plus `{8,12,16,20}` for wide gutters, touch targets, and large clearance. Named keys `xs/sm/md/lg` on the layout cvas in `apps/web/src/styles/layouts.ts` map to `1/2/4/6`. Treat deviations as a visual-review decision, not a CI regex violation.
- **Exemptions:** `src/ui/primitives/**` (shared primitives — their `px-3` etc. is the design system's own component padding) and the rare genuinely-dense sub-scale spot (`gap-0.5` optical nudges, dense calendar cells) marked with an inline `/* tight */`. Use `/* tight */` sparingly — and prefer encapsulating density in a component over scattering the marker.
- `gap-*` for flex/grid containers (siblings laid out by the parent); `space-y-*` only for plain block stacks with no flex/grid context.

## Layout primitives

- **Pages defer to the layout primitives, not raw flex/grid/space-y Tailwind.** Import `Row` / `Stack` / `Grid` / `Section` from `~/ui/layout` (cvas in `apps/web/src/styles/layouts.ts`):
  - **`Stack`** — vertical block stack (`space-y-*` under the hood). `gap`: `tight(0.5) | snug(1.5) | xs(1) | sm(2) | md(4, default) | lg(6)`. Replaces `<div className="space-y-N">`.
  - **`Row`** — horizontal flex. No defaults (a bare `<Row>` is just `flex`). `align` (start/center/end/baseline/stretch), `justify` (start/center/end/between/around), `wrap`, same `gap` scale. Replaces `flex items-center gap-N` (± `justify-between`).
  - **`Grid`** — `cols` presets `cards3 | thumbs | images | summary` + `gap`. Non-preset/custom `grid-cols-[…]` stay raw.
  - **`Section`** — semantic `<section>` with an optional `title`/`description` header (`h2` heading typography, fixed `gap="md"`) over a `Stack` body. Use for a titled page region; use `Card` when it needs a bordered surface.
  - `Row`/`Stack`/`Grid` are polymorphic via `as` (`as="ul"/"li"/"form"/"button"`; `Row`/`Stack` also take `type`/`disabled` for `as="button"`). They do **not** accept `href`/router props — leave `<a>`/`<Link>` raw. (`Section` always renders a `<section>`.)
- **Sub-scale density lives in the `gap="tight"/"snug"` variants** (defined in `layouts.ts`, a `.ts` the spacing guard doesn't scan) — so dense UI needs no `/* tight */` marker. The marker now only covers genuine sub-scale **padding/margin** (no primitive prop for it).
- **Bar for reaching for a primitive:** the layout repeats or encodes a real decision — don't wrap a lone one-off `<div className="flex">`, a `flex flex-col` column, a responsive `flex-col sm:flex-row` switch, an `inline-flex`, or a className on a shadcn primitive. Keep sizing (`h/w/flex-1/shrink-0`), color, position, `rounded/shadow`, and typography inline via the primitive's `className`.

## Tables

Three layers — pick by what the surface is, never hand-roll table styling:

- **`<RTable>`** (`~/entity/table/table`) — the TanStack orchestrator for an **interactive list**: sortable / filterable / paginated / selectable rows, mobile cards, grouping. Big CRUD list pages.
- **`<Table>` primitives** (`Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` from `~/ui/primitives/table`) — for **static tabular data** embedded in a page/panel (`<RTable>` would be overkill). Don't re-implement `border-collapse` + inline `border-b`/`py-1 pr-2` cell padding; the primitives own borders, padding, hover, and the uppercase-mono eyebrow header (`<TableHead>`). `<Table>` is **pure styling over native `<table>`** — it does no row-modeling, so `rowSpan`/`colSpan` and nested/grouped rows pass straight through.
  - Two defaults are tuned for `<RTable>`'s explicitly-sized columns: `<Table>` is **`table-fixed`** and `<TableCell>` is **`whitespace-nowrap`**. For content-sized columns pass `className="table-auto"`; for wrapping prose cells add `whitespace-normal`. Suppress an unwanted row divider with `border-b-0` (e.g. grouped/`rowSpan` clusters). Keep the bordered-card wrapper via `containerClassName`.
- **Raw `<table>`** only when those defaults actively fight the layout: **matrices / cross-tabs** (entities as columns, sticky panes, per-cell heatmap/stat styling — e.g. `RecipeCompareGrid`, `IngredientComponentGrid`), **dev/debug-only** surfaces (`perf-overlay`, costing-debug card), and **external-content** rendering (`markdown.tsx`).

### Row height

- **`<RTable>` rows are one fixed height (`ROW_DENSITY` in `ui/data-table/density.ts`).** The virtualizer and the fast-scroll ghost rows place rows at `rowHeight`; a taller painted row makes scrolling jump. `DesktopDataRow` holds every cell's content to that height and clips overflow, so a stacked cell gets cut off rather than stretching the row. A cell holds at most two lines that fit the row: `StackedValue` (`ui/common/stacked-value.tsx`) sets a 15px value over a 13px muted line, which desktop dates and timestamps use automatically, and `ChipCluster` (`ui/common/chip-cluster.tsx`) wraps chips to two lines and counts the rest as "+N" (including a bounded preview's unsent items, `more`) instead of an expander, dropping chips whose painted lines would overflow the row; related-record previews use it too.
- **A value inside a desktop cell takes its dense form** (`DenseCellContext`, set by `DesktopDataRow`; another surface opts in with the component's `stacked` prop). Dates stack; an inline entity link sets its 12px name over its muted context ("1 each · shelf" for a stocked location), or wraps a context-less name to two lines; a quality score drops its "/100"; a product barcode keeps its first and last four digits. A hoisted link still resolves its record's emoji before dropping its mark. When every value in a column links to one entity (`meta.linksTo`), the header paints that entity's icon once and each link drops its generic icon, keeping a record's own image or emoji. Add a dense form to the shared component behind this context, not a table-only twin. Leave longer detail to the record page. `table-row-height.spec.ts` covers a stacked USDA cell and the shared multi-reference cell; `table-density.preview.test.tsx` covers spill-over, stacked dates, chips, codes, header wrapping, and the overlay rail; `table-density.spec.ts` covers the Products table's count header, hover-only header marks, stacked year, overlay ⓘ, reference cap, muted derived price, "/ea" unit price, code ends, header entity icon, stacked location, and the category spill-over's ⓘ.

### Column widths

- **`useTableColumnLayout` seeds order, pinning, visibility, and sizing; TanStack holds them in session state.** Reloading or reopening restores declared defaults; do not add browser or account persistence for column layouts.
- **`moveColumn` is the one writer of user layout changes** — header drag, customizer drag, move earlier/later, pin and unpin — and `applyColumnLayout` replaces a whole layout (Restore default, saved views), both in `ui/data-table/column-layout.ts`. Pinned-region order lives only in `columnPinning` and center order in `columnOrder`; every surface reads regions through `columnsByRegion`, so the header and the Columns dialog list one order. A same-region move lands where dnd-kit's sortable preview shows it; a pin appends to its region, an unpin returns the column to its own `columnOrder` slot, and a drop onto a column takes that column's slot. `table-column-layout.spec.ts` covers each path and the reload.
- **Widths are TanStack numeric `size` / `minSize` / `maxSize` values.** The table platform publishes matching CSS width variables for header, body, footer, sticky offsets, native resize, and session customization. Tailwind width classes on `meta.className` are legacy input only and are normalized at the platform boundary.
- **An undeclared width comes from the cell kind** (`defaultColumnSize` in `column-layout.ts`): identity 240, boolean 56, stacked timestamp 72, stacked plain date 72 (a date ignores its `display.width` bucket), number/currency and amount 72, select/enum pill 104, entity reference and free text 160. `maxSize` defaults to at least 240 so a narrow default never clips a one-line form; the minimum is 32. These are initial estimates before rendered-content fitting. Measurement fields ignore symbolic text-width buckets and retain explicit numeric sizes. Header labels (`HeaderLabel`) wrap to two lines, so header fitting counts the label's longest word or about half its one-line width plus the 4px cell padding, up to 160px; longer headers clamp. A header paints its short form: `display.columnLabel`, else "X count" as "Xs" (`entity/column-header.ts`); a number counting one entity's records paints that entity's icon and "#" unless another visible column counts the same entity. The full label stays the header's accessible name and tooltip. Only a sorted column's arrow takes width; the hover arrow and the source icon overlay the header's free edge while it is hovered or focused. Read-only enum, boolean, date, and timestamp fields carry their own cell kind (`select`, `boolean`, `date`, `timestamp`) so they size like their editable twins, never as free text. Fit actual rendered headers and a bounded sample of values through the shared table rather than adding per-entity widths; a field declares `display.width` only when its longest label outgrows the kind default (a long enum like `expense.lineKind`).
- **Rendered-content fitting samples headers, aggregate footers, and at most twelve painted body rows** in one inert offscreen batch. Visible value icons and footer padding count; only explicitly marked hover pencils and header layout controls are omitted, a wrapping chip cluster (`data-cell-wrap`) fits its first chip and wraps the rest, and a loading placeholder (`aria-busy`) is left out of its cell's sample, since a fit that only grows would keep its width. Fits grow within a filter/sort/page scope as enrichment arrives and reset with that scope. Active editors retain the previous fit, and manual sizes win. Sticky offsets sum the painted CSS widths, including fitted widths, rather than TanStack's initial estimates.
- **No column grows to its widest value; fits stop at the kind's cap** (`columnFitMax`): 240px for the identity, 160px for free text, references and chips, 120px for a select pill or a column of links to one entity (`meta.linksTo`, whose names wrap to two lines), 96px for a mono code; numbers, money and dates keep their natural width. A person's resize still reaches `maxSize`.
- **Pane slack goes only to the identity column** (unless it is pinned or user-resized), up to its 240px fit; unused width goes to the trailing spacer.
- **Clipped values spill instead of widening their column.** `useCellSpill` lifts a clipped value (`[data-cell-spill]`, `CellFrame`'s value, a stacked line with its partner, a two-line clamped name, a clamped header label, or `.truncate` text) over its neighbours at the row's height after 250ms of hover, or on keyboard focus, growing toward the start near the pane's end edge. The overlay is pointer-transparent, so clicks reach the cell (a copied sort arrow included), apart from the copied controls of the rail beside the value: the outermost rail outside the spilled value, so a value wrapped in its own in-flow frame (a suggestion mark) still carries the outer ⓘ, and a header carries its sort and source chrome. `MiddleTruncate` keeps a path's last segment and another long unspaced label's last four characters, showing either in full when it fits; with `code` (barcodes, order ids) it always shows the first and last four ("0123…8905"), its hidden middle `data-fit-elide` so the column fits that form, and the full code spills on hover.
- **Select and Image are structural leading columns.** Select is fixed at 32px and cannot resize. The image frame fills the 32px data row; its structural column includes the 1px divider. When present, layout normalization keeps them visible, start-pinned, and first/second; their definitions disable pinning, hiding, cell selection, and reorder handles. Actions is the structural trailing column: end-pinned and kept last after any column the user pins to the end, never moved, hidden, or re-pinned.
- **Cell rails overlay the active row** (`CellFrame overlay`). The explanation ⓘ and the relation workbench mount only on the hovered or focused row and sit over the cell's free edge: the start of a right-aligned number, else the end of the text, where the spill-over then shows the value, even one that exactly fits but sits under the ⓘ, with a working copy of the rail past its end (before a number) so no character stays covered. They reserve no width, and a floating frame nested in another shares its rail, so the ⓘ never covers the workbench. A resolution mark overlays too; a derived value (inherited or allocated) reads muted, and an inherited one keeps the shared Inherited marker (`InheritedMarker`, Phosphor TreeView) visible after it without hovering. An actionable suggestion is status, so it stays in flow and visible, and a suggestable column reserves 18px for its mark. The desktop info control is 16px with a 10px glyph; coarse pointers keep the rail in flow and visible with the 44px target. A browser test hovers a row before using its ⓘ, as a person does.

- **Generic entity list pages show Created then Updated by default**, after domain and related columns and before Actions, for both server-backed and client-backed lists. The shared timestamp cells stack the household-local day over its compact age ("Oct 11" / "3mo ago"; another year leads the age line, "’25 · 1y ago"), with the exact timestamp on hover. These are ordinary data columns: users can hide, move, pin, and resize them during the session. Embedded relationship tables retain their default-hidden audit columns; phone rows retain their existing semantic projection.
- Custom list projections must return both audit timestamps. Tree adapters preserve them on each top-level row shape; heterogeneous child rows use the timestamps of their own entity, such as candidate Products beneath a Wish.
- Keep the trailing gutter cell at `w-0`; declared numeric widths own the rendered geometry and overflow scrolls horizontally when the table is wider than its container.

## Detail ledgers

Use `ui/common/ledger.tsx` for repeated read-only facts, and `ui/common/record-list.tsx` (`RecordList`, `RecordRow`, `RecordGroup`, `RecordHeading`, `RecordMore`, `RecordFold`, and the `RecordScore`/`RecordHops`/`RecordDot`/`RecordDetail` parts) for read-only record lists; it renders a records `Ledger`. Date values use `ui/common/date-display.tsx` (`DateDisplay`). A `LedgerRow` outside a `Ledger` throws in development, because subgrid rows silently lose their columns without one. The ledger container stretches in any parent: inline-size containment ignores content width, so a start-aligned parent would otherwise measure it as 0px. `Ledger` chooses only facts versus records and the semantic root (`dl` or `ul`); compose `LedgerRow` with `LedgerCell` slots for leading identity, primary content, secondary evidence, trailing value, actions, and expanded details. Facts use a grouped `div` containing `dt` and `dd` cells. The container owns column adaptation, so an inspector or popover does not inherit a wide-page layout. Share geometry without moving links, commands, choices, mutation state, or raw diagnostics into the primitive. `BasicInfo` places scalar provenance beside its value and right-aligns its action rail; prose spans the value region. Rows with a photo or form controls move secondary evidence beneath the identity and reserve the photo across both lines. Pinned selected cells use an opaque mixed surface; never apply a translucent background utility over that surface.

Expanded action forms and full-width exception prose span a lower ledger row rather than widening the action rail. Phone-card explanation controls retain their own positioned stacking layer above the stretched record link; a larger touch target must remain clickable. Tests select the semantic facts ledger and assert actual labels before checking declaration order. Offscreen column fitting preserves resolved cell typography. Browser readability checks compare painted text against clipping bounds, excluding intentional edit-control hover padding; timestamp checks follow the hovered trigger's accessible tooltip relation rather than requiring a page-wide singleton.

Only a form or `data-ledger-expanded` content moves actions below the record; compact controls remain in the rail. Expanded action cells use a block container, and the trailing status spans the released action track so it stays at the row edge.

Fact labels and controls center against the whole value block, including wrapped values; full-width prose keeps its separate row. A failed photo retains the same evidence layout through its semantic image fallback; SVG identity icons do not select that photo layout. Interior column rules exclude the pinned start boundary so its full-strength hairline remains visible.

## Entity names are always readable and always clickable

Every entity in `entities.tsx` has a detail route, so **a rendered entity name is never plain truncated text.** Two acceptable shapes:

- **`EntityRefLink`** (default `inline` variant; `chip`, `list`, `byId`, `preview`, `table`, `audit`, `filter`, `order` cover the other shapes) — links to the detail route and reveals the full name in its hover preview card. Use it for any entity in `HoverPreviewEntity`; adding a `title` on top of it would just double up with the card. Pass each entity's real title field (`displayName` for financial transactions and `filename` for images), rather than inventing a generic `name`.
- **A truncated span/link carrying `title={name}`** — for the surfaces the inline variant doesn't fit (chart axis labels, tree rows, calendar chips). Link it too unless an ancestor `<a>` already owns the click (nested anchors are invalid — see the calendar `MealChip`) or the row genuinely carries no id (`ingredientAvailabilityOut`'s sub-recipe rows).

Inside an `<RTable>`, **use `createNameColumn`** — it bundles width + `truncate` + full-name `Tooltip` + an `EntityRefLink` `table` variant to the detail route, plus optional inline rename. Hand-rolling `cell: ({row}) => row.original.name` is what made the project detail page's Task/Expense names unreadable and unreachable. `header` overrides the label for tables embedded under another entity ("Task", not "NAME"); `nameSuffix` carries any secondary affordance (e.g. an expense's external vendor link) without stealing the name's own click.

An embedded table must also reach **its own** rows' entity, not just their relations — `location-inventory-table` links product and location on every row, so the amount cell carries the `/inventory/$id` link (`renderDisplay`).

## Page shell

- Every list and detail page renders through one shell: `Page` from `~/entity/page/page` (`HydrateClient` + `PageWrapper` + unified `PageHeader` + `Suspense`). Props are a discriminated union — `variant="detail"` requires `entity` at compile time. Lists use a compact contextual heading or workbench; details use an open contextual header with a structural divider, optional 48px identity thumbnail, quiet metadata, and visible Edit/main workflow actions with remaining actions in overflow. Global desktop search and create live in the sidebar. Shared headings and disclosure behavior follow [the Section contract](../DESIGN.md#shared-headings-and-actions). Don't reintroduce `EntityLayout`/`DetailPage` (deleted) or call `PageHero`/`PageWrapper` directly in pages — use `Page`. Detail bodies use `DetailSections` (`~/entity/table/detail-page`) as `Page`'s children.

### Ordinary overlays

Use [`Overlay`](../src/ui/overlays/overlay.tsx) for modal workflows and workspace
panels. [DESIGN.md](../DESIGN.md) owns its
presentation and submission-lifetime contract. Pass actions directly from the
owner; forms use a shared native form id. Specialized command, photo and
modeless inspector surfaces keep their existing engines.
