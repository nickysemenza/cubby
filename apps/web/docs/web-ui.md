# Web UI contracts

This file owns which shared component renders what, and the implementation rules
behind it. [DESIGN.md](../DESIGN.md) owns appearance and interaction;
[web runtime rules](web-runtime.md) own hooks, loading and caching. Load the
heading for the surface you are changing.

## Tokens, icons and badges

- Components never hardcode colors (hex/oklch). Shared palette and semantic
  primitives (`--positive`, `--warning`, `--destructive`, …) live in
  `packages/design-tokens/brand.css`; web-only derivations such as the chart
  ramp (`--chart-1..8`) live in `apps/web/src/styles.css`. Map green to
  `positive`, red to `destructive`, amber to `warning`. Canvas paint,
  `theme-color` and chart-library fallbacks are the usual exceptions; this is a
  review rule, not a lint.
- A new semantic color gets its primitive in `brand.css` and a `--color-*`
  mirror in `styles.css`'s `@theme inline` when Tailwind utilities need it.
  Composite shadow tokens (`--shadow-overlay`, `--shadow-pin-*`,
  `--text-shadow-chart`, …) need no mirror; use `shadow-[var(--token)]`. Never
  inline `rgba()` shadows; add a token.
- Icons use the `size-N` shorthand, never `h-N w-N`: `size-3.5` for inline and
  navigation glyphs, `size-5` for card, tile and hero icons, `size-3` for
  micro-indicators. Interactive primitives (Button, DropdownMenu, Command, Tabs,
  Toggle) already size their icon slot to `size-3.5`.
- `Badge` is the categorical chip, sentence case by default; don't hand-roll
  pill styling.

## Spacing and layout primitives

Spacing utilities normally use Tailwind steps `{0, 1, 2, 4, 6}` plus
`{8, 12, 16, 20}` for wide gutters, touch targets and large clearance. Deviations
are a visual-review decision. `src/ui/primitives/**` keeps its registry padding.
A genuinely dense sub-scale padding or margin is marked `/* tight */`; prefer a
component that encapsulates the density over scattering the marker. `gap-*` is
for flex and grid siblings; `space-y-*` is for plain block stacks.

Pages compose `Row`, `Stack`, `Grid` and `Section` from `~/ui/layout` when the
layout repeats or encodes a real decision. Their variants live in
`src/ui/layout/layouts.ts` and share one named scale read from the design-token
spacing steps: `tight` 2px, `xs` 4px, `snug` 6px, `sm` 8px, `md` 12px (default
for `Stack` and `Grid`), `lg` 16px. `tight` and `snug` are the sanctioned dense
sub-scale and need no marker.

- **`Stack`** is `flex flex-col` with `space-y-*` margins, so inline children
  still break onto separate lines. It replaces `<div className="space-y-N">`.
  A child that is `inline-flex` with no width (a bare `Button`) stretches to the
  stack width.
- **`Row`** is `flex` with no defaults; `align`, `justify`, `wrap` and `gap` are
  opt-in.
- **`Grid`** takes `cols` presets (`pair`, `cards3`, `thumbs`, `images`,
  `summary`) and `gap`; custom `grid-cols-[…]` stays raw.
- **`Section`** renders a semantic `<section>` with an optional heading; its
  presentation is in [DESIGN.md](../DESIGN.md#page-building-blocks).
- `Row`, `Stack` and `Grid` are polymorphic through `as`; they take no `href` or
  router props, so `<a>` and `<Link>` stay raw.
- Don't wrap a one-off `flex`, a plain `flex-col`, a responsive
  `flex-col sm:flex-row` switch or an `inline-flex`. Sizing, color, position,
  radius and typography stay inline through `className`.

## Images

- Every `<Image>` declares `displayWidth` as the box's true maximum rendered CSS
  width at its widest breakpoint, or opts out with `unoptimized`; the
  `ImageProps` union enforces this. `transformedImageUrl` (`src/lib/image-url.ts`)
  requests 2× and snaps up to `IMAGE_WIDTHS` 128/640/2048, so small placements
  share one URL and cache entry, and overstating a width fetches a larger rung.
  There is no `srcSet`. The native app mints identical URLs
  (`CubbyKit/Media/ImageTransform.swift`); change the ladder in both or neither.
  Non-bucket URLs pass through unchanged, so the rule has no allowlist.
- `Image` owns lazy hover previews below 256px declared width through the shared
  `ImagePreviewPopup`. `EntityCover`, `ImageThumbnail`, table thumbnails and
  image-view tiles reuse it. Pass `preview={false}` for decorative images,
  existing preview content or a trigger that owns its popup. Missing and failed
  images never preview. Identity thumbnails contain the whole image.
- List thumbnails come from the row's server-resolved `displayImages`
  (`createImageColumn`); the policy is in
  `server/entity-kernel/repo/entity-display-image.ts`. Clicking a table
  thumbnail opens its display-image source chain.

## Dates and times

- Every human record date, timestamp and declared date range renders through
  `DateDisplay` (`ui/values/date-display.tsx`). Outside tables it shows the
  absolute date with year (and clock time for an instant) followed by a muted
  relative distance: "Oct 13, 2026, 11:50 AM · 2 minutes ago". Instants format in
  the household zone; plain days never convert through UTC and compare
  household calendar days. Today, yesterday, tomorrow and ongoing ranges keep
  those labels; ended ranges take relative context from their end, future ranges
  from their start. Shipment tracking timelines use this full form.
- Inside desktop tables (`DenseCellContext`; static tables opt in with
  `stacked`) the month/day and a compact distance share the cell: "Oct 13 · 3 min
  ago". Minutes are `min` and months `mo` with a space, and another year leads
  ("’25 · 1y ago"). Tooltips on hover and focus give exact seconds and the
  household offset. Date columns start at 96px and declared spans at 320px.
- Mounted labels share `useDisplayNow`, refreshing each minute and on focus or
  visibility change, independent of refetches. `formatTimestamp` and
  `formatDateSpan` give the same label for string captions; `formatCalendarDay`
  and `formatInstant` stay absolute for inputs, axes, headings and diagnostics.
  Keep dates absolute in record names, persisted evidence and sentences that
  already state relative context; relative ages never enter AI evidence.
- Historical date filters share `historicalDateRangePresets` and
  `resolveDateRange` (`lib/date-range-presets.ts`), with the same keys, labels
  and inclusive household-day arithmetic in tables and charts; saved filters
  keep relative keys. Past month and 12 months are calendar months with month-end
  clamping. Clearing a range removes both bounds. Timeline windows and imports
  use `DateRangeShortcuts` and freeze resolved bounds. Deadline editors keep
  future semantics.
- Plain-date editors use `DatePickerInput`: typed dates and English expressions
  such as `1 year ago`, resolved at commit in local calendar time with month-end
  and leap-day clamping. Invalid drafts stay visible without replacing the
  committed value.
- Desktop cells with `DateDisplay`'s open-overdue marker take the destructive
  tint across the cell, through hover and selection (selected cells keep a ring);
  the overdue text stays as a second signal and shared status logic clears both.

## Values, enums and references

- Reference labels read their declared title field through `readRecordField`,
  including derived values. Report rows that already resolve related labels
  include them rather than fetching from a mounted cell. A Vendor Account's title
  derives from Vendor and member.
- A declared enum field renders as `EnumPill` through one roster,
  `enumFieldOptions`/`enumFieldLabel`
  (`entity/display/enum-field-display.tsx`), on every surface, and is
  inline-editable wherever the entity has an update command. The option's
  compiled `role` picks `StatusValue` or `CategoryValue`; booleans render as
  `BooleanValue`. Never read `control.options` directly for a label or
  hand-write an enum column: declare labels, colors and each option's `glyph`
  (Phosphor name plus SF Symbol; web map in `ui/media/option-glyph.tsx`) in
  `control.options` or `display.valueOptions`, and width/mobile on the field.
  `ENTITY_SELECT_OPTIONS` holds only web editor sentinels.
- Reference displays whose projection omits the name use the shared by-id
  resolver, never the stored identifier. Pending reads show loading; missing
  records and failed reads stay explicit with raw diagnostics.
- Suggestion proposals, alternatives and correction evidence use the canonical
  suggested-field renderer on detail pages and in table reviews. Proposed values
  never borrow the current record's resolved values, labels or allocations;
  declared enum options keep their canonical labels.

### Technical representations

Use `InspectableValue` (`ui/values/inspectable-value.tsx`) for explicitly chosen
readable/raw pairs: the readable label stays visible with a dotted underline,
hover or focus reveals the exact raw value, and click keeps the popover open for
selection and Copy. Pass the exact technical string. Do not hide essential facts,
wrap existing buttons or links, or make every field inspectable. Run types and
run timeline reason, phase and input-mode labels use it.

## Value pickers

Every value choice renders through `Picker` (`ui/combobox/picker.tsx`);
`PickerField` (`entity/forms/picker-field.tsx`) is its only react-hook-form
binding. Native `<select>` (`cubby/no-native-select`) and raw Base UI
combobox/select/autocomplete/toggle-group (`cubby/no-raw-value-control`) are
banned outside it. `DropdownMenu` and the `cmdk` command menu are for navigation
and actions, never values. [DESIGN.md](../DESIGN.md#controls-and-suggestions) owns
the picker's appearance.

- Choose the mode explicitly: `search` for records and long lists, `choose`
  (Base UI `Select`) for a short fixed list, `segmented` for a handful of view
  modes, `suggest` when the typed string is the value. `multiple` keeps several
  values as chips; `footer` pins Clear/Apply for a draft filter. Each mode keeps
  its own value, empty value, focus and search contract.
- String choices pass `options` (`PickerOption`). Records pass `items` built by
  `entity/picker/combobox-builders.tsx` from the manifest: `displayImages[0]` is
  the picture and the `display.mobile` `subtitle` and `trailing` slots supply
  secondary and trailing columns, plus up to two declared metadata values as a
  searchable line. Declare those slots rather than hand-building rows.
- A picker never displays or announces a shortcode: stored codes resolve through
  `useSelectedPickerItems` with a loading state.
- Search-mode empty results use the mounted `Combobox.Empty` part with
  conditional loading and error children; a plain element lets Escape close the
  parent dialog. Test dismissal through the real dialog.
- The picker frame owns its focus ring; the nested input suppresses its own.
  On phones inline suggestion marks reserve their 44px target, and invisible hit
  areas must not cover neighbouring controls.

## Record identity

Every entity has a detail route, so a rendered entity name is never plain
truncated text. Use `EntityRefLink` (all record links; variants `inline`, `chip`,
`list`, `byId`, `preview`, `table`, `audit`, `filter`, `order`), which links to
the detail route with a hover preview, passing the entity's real title field
(`displayName` for financial transactions, `filename` for images). Where the
inline variant doesn't fit (chart axes, tree rows, calendar chips), use a
truncated link with `title={name}`, unlinked only when an ancestor `<a>` owns the
click or the row has no id. Inside `RTable` use `createNameColumn` (width,
truncation, tooltip, `table` link, optional rename; `header` relabels embedded
tables, `nameSuffix` adds an affordance). An embedded table also links its own
rows' entity, not only their relations. Audit history may name retired entity
kinds; icon lookup tolerates absent metadata and leaves them unlinked. Inventory
and cookbook shortcodes keep their own detail destinations.

### Record link appearance

`EntityRefLink` renders a record pill by default; table name columns use `bare`.
The pill owns image size, text, fallback marks and wrapping; declarations own
labels and identity data. Candidate filter rows reuse the noninteractive pill.
Never start an image or record-mark query from a cell or option row; a missing
mark falls back to the canonical entity mark.

### Record pill display images

All record identity imagery uses the canonical display-image resolver. Raw
galleries, Product image summaries and direct logo/cover joins never select a
second identity image; URL-only picker projections serialize canonical results.

- Collection owners batch image refs for their loaded rows through
  `EntityDisplayImagesProvider`, including transitive images along declared
  relationship paths. The shared app provider collects otherwise-uncovered
  mounted references into the same chunked resolver. Pills register references
  and never own a query; explicit batches and seeded null results stay
  authoritative. `useEntityDisplayImage` accepts a known seed.
- Grouping labels use `GroupValueLabel`; `GroupLabelsProvider` batches
  record-valued group identities, including nested dimensions, for pivots,
  grouped tables, cards, shelves and boards. Scalar, date and empty groups stay
  text.
- Detail headers use the canonical resolver when the local gallery is empty,
  including Vendor logos and inherited Brand images, resolved at the page
  boundary. The Images section shows only the record's own gallery.
- Calendar grids, span chips, agenda rows and the day sheet share one provider
  seeded from the range response's `displayImages`; the day sheet makes no
  separate image query.
- Location trees carry canonical media for the whole loaded tree; child photo
  contact sheets are compartment evidence, never a parent fallback. Native
  consumers follow the same contract.

## Tables

Interactive record work uses `RTable` (`entity/table/table.tsx`): search,
filters, sorting, selection, grouping, row navigation and inspection belong
there, not in a second list implementation. `cubby/no-raw-table` rejects raw
`<table>` outside exempted files.

- **`StaticTable`** renders simple read-only summaries, reports, comparisons,
  form previews and debug reports. It shares `RTable`'s table atoms and native
  attributes: columns, conditional visibility, row headers, row styling and cell
  props (covered spanning cells return null). `rowDetail` renders a full-width
  row under its parent with caller-owned open state. Never add filtering,
  navigation or inspection to it.
- **`Table` primitives** (`~/ui/primitives/table`) are styling over a native
  table for embedded static data: they own borders, padding, hover and header
  type, and pass `rowSpan`/`colSpan` through. `Table` is `table-fixed` and
  `TableCell` `whitespace-nowrap`; pass `table-auto` or `whitespace-normal` for
  content-sized or prose cells, `border-b-0` to drop a divider.
- **Raw `<table>`** is for matrices and cross-tabs (`CrossTabTable`,
  `RecipeCompareGrid`), spanning dependency grids and authored document tables
  (`markdown.tsx`), each exempted by path in `.oxlintrc.json`.
- **`useLocalTable`** gives bounded non-entity lists client-side
  search/filter/sort and the shared column layout. Its search accessor may cover
  evidence outside visible columns. Only complete local data supplies result and
  facet counts; `totalCount` marks a truncated source and suppresses them. It
  never touches URL state.
- Grid wrappers around tables use a zero-minimum track (`grid-cols-1`) so wide
  columns scroll inside the table.

### Keyboard, selection and copy

Arrows move between cells; Cmd/Ctrl+arrow jumps to the data edge; Home/End go to
the first/last column and Cmd/Ctrl+Home/End to the first/last cell; PageUp/Down
move one viewport; Shift extends a range; Tab wraps at row boundaries. Editors
keep their own keys; J/K step rows and Cmd/Ctrl+Enter opens the record. Nested
links, buttons and ARIA controls (including SVG icon targets) own their clicks and
keys and never also activate the row; a phone row's own `role=button` is the row
surface. An open inspector owns Escape before the grid resets selection. Bulk
selection and the inspector's current row stay independent.

Highlighted text uses native copy. Cell selection copies the complete value even
when clipped. Scalar columns share `createEditableAccessorColumn`: one
row-parametrized clipboard descriptor supplies range operations and the editor.
Columns without a typed clipboard declaration copy as read-only text.

### Row height

`RTable` rows have one fixed height (`--table-row-height`, read by `ROW_DENSITY`
in `ui/data-table/density.ts`): 24px on a fine-pointer desktop, 32px on coarse
pointers and hosted native workspaces. The virtualizer places rows at that
height, so a taller painted row makes scrolling jump; section headers match it.
`DesktopDataRow` clips every cell to the height.

- At 24px every cell is one line: `StackedValue` lays its parts on one line and
  `ChipCluster` fits one line of chips and counts the rest as "+N" (at 32px both
  keep two lines). The first named chip stays visible, truncating beside the
  count; a populated cell never collapses to only "+1".
- A value in a desktop cell takes its dense form through `DenseCellContext`
  (set by `DesktopDataRow`; other surfaces pass `stacked`). Add dense forms to
  the shared component, not a table-only twin. Clipped codes use
  `MiddleTruncate`.
- Enum values read as a dot and text at `md` and above (`table.css`, keyed off
  `data-enum-tone`); only `status`-role warning and destructive options keep a
  filled pill. The choice reads the declared role and tone, never the spelling.
- Inventory relation cells keep location and quantity in the two-line dense
  budget; supplemental stock context moves to hover and accessible text. A third
  line never overlaps the next row.

### Table chrome

- The toolbar is search, `Filter`, `Display` and `Actions`. `DisplayMenu` holds
  layout, sort, group and columns, each keeping its owner (URL `view` and
  `groupBy`, table sorting, column layout); a dot marks a non-default
  arrangement. Views without a table get it from `ListWorkbenchMenus`. `Actions`
  holds saved views and Find suggestions.
- `TableFooterBar` is always visible on a page list, one row tall. It prints the
  record count ("20+ products" while uncounted), declared totals, unresolved
  membership, suggestion status and "+N empty". Column sums print only when the
  list declares no totals, marked "(loaded)" while pages remain. Prior values
  stay dimmed during transitions; "Unavailable" means a failed read or a missing
  total.
- A counted page reports `unresolvedCount` only under a result filter, so
  `useEntityList` counts any list with an active non-search filter; an absent
  count shows nothing.
- Right-click on a desktop row opens its `meta.rowMenu` at the pointer;
  modified clicks, text selections and inputs keep the native menu.
- Group headers are sticky one-row bands with metrics under their columns
  (`columnTotals`).
- Generic lists hide Created and Updated unless sorted by them. Custom list
  projections return both audit timestamps; tree child rows use their own
  entity's timestamps.
- An opt-in `printable` table renders its loaded filtered rows and open details
  through `StaticTable` outside the virtualized pane; it never fetches unloaded
  pages.

### Column widths

- `useTableColumnLayout` seeds order, pinning, visibility and size; TanStack
  holds them in session state and reloading restores declared defaults. Do not
  add browser or account persistence for column layouts.
- `moveColumn` is the one writer of user layout changes and `applyColumnLayout`
  replaces a whole layout (`ui/data-table/column-layout.ts`). Pinned order lives
  only in `columnPinning`, center order in `columnOrder`, and every surface reads
  regions through `columnsByRegion`.
- Widths are TanStack numeric `size`/`minSize`/`maxSize`; the platform publishes
  matching CSS variables on the colgroup, and only sticky offsets inherit into
  rows. Tailwind width classes on `meta.className` are normalized legacy input.
- An undeclared width comes from the cell kind (`defaultColumnSize`).
  Read-only enum, boolean, date and timestamp fields carry their own kind so
  they size like editable twins. A field declares `display.width` only when its
  longest label outgrows the kind default.
- Rendered-content fitting samples headers, aggregate footers and at most 36
  painted body rows in one offscreen batch, skipping skeletons and `aria-busy`
  placeholders. Fits grow within a query scope and reset with it; unchanged cells
  keep their measurement, editors keep the previous fit and manual sizes win.
  Fits stop at the kind's cap (`columnFitMax`); spare pane width goes only to
  the identity column, up to 240px.
- Header labels (`HeaderLabel`) hold one line and paint their short form
  (`display.columnLabel`, or the entity icon for a count; `entity/column-header.ts`),
  keeping the full label as accessible name and tooltip.
- Empty columns leave the painted grid (`emptyColumnIds`) until the footer's
  "+N empty" brings them back; cell selection skips them.
- Clipped values spill over neighbours instead of widening (`useCellSpill`,
  `[data-cell-spill]`); `data-cell-spill-off` exempts a control. Spills forward
  presses to their source cell and copy rail controls.
- Select (32px), Image and the identity are structural leading columns, kept
  visible and start-pinned; Actions is the structural trailing column. The
  trailing gutter cell stays `w-0`.

### Cells

- Decorated cells render through `CellFrame`; never append icons beside a value
  by hand. Hover-only controls (explanation, relation workbench, resolution
  marks, rich-reference edit pencils) use `CellFrame overlay`, reserve no width,
  mount only in the hovered or focused row and step aside over clipped text.
  Explanation buttons keep 44px targets on phones and coarse pointers, and status
  text uses the body font even in numeric columns.
- A missing derived value uses `MissingFieldValue` with a focusable explanation.
  An inherited value keeps `InheritedMarker` visible; suggestion marks stay in
  flow.
- One-line chip lists use `ChipCluster lines={1}`; two-line content uses
  `StackedValue`, `ChipCluster` or a shared dense form.
- Every identity cell holds one line of name text: no caption, subtitle or pill
  beneath. `createNameColumn` has no caption option. Shelf cards keep declared
  subtitles; `list.titleSubtitle` does not affect web tables.
- `display.columnBar` adds magnitude against the largest absolute loaded,
  filtered value (`CellMagnitudeBar`); loading more can rescale it. The signed
  value and clipboard stay authoritative; zero and unavailable values get no bar.
  Opt in for comparable money, counts, durations, calories or sizes; never mix
  units or fabricate targets. A bar is magnitude, not completion.
- Declared `display.columnGroup`s are metadata for the Columns menu: bands stay
  contiguous, move and pin as a unit, and Show/Hide toggles members. Every entity
  list declares its own thematic groups; identity, quality, images and audit
  timestamps stay outside them. Related-preview columns declare the same groups.

### Inspector

`RTable`'s `inspector` composes `SidePanelLayout`: a right column at wide widths
and the shared sheet below, with row stepping over the filtered, sorted model.
`desktopInspector` is the docked slot for hosts whose inspection owner already
handles responsive presentation. Responsive layouts that move an editor between
sidebar and sheet keep selected values with the page's selection owner.

### Renderer stability

- Column factories reuse module-level render components for selection
  controls: `flexRender` treats callbacks as component types, so refreshed
  metadata must not remount a focused checkbox. Standard editable cells keep
  their identity across roster and metadata refreshes.
- Preferences that change independently of row data reach cells through React
  context; recreating column closures does not update memoized rows, and do not
  remount the table.
- A `cell` depending on separately fetched data reads `row.original`, never
  `info.getValue()`: TanStack freezes accessor results in `row._valuesCache`.
- Unchanged rendered cells keep their measured width contribution within a query
  scope, and mutations without an unmeasured eligible cell skip geometry reads.

### Component traps

`DropdownMenuLabel` crashes unless wrapped in `DropdownMenuGroup` (Base UI, not
Radix). Base UI `useRender` wrappers keep their default tag's prop types; put
button-only props on the `render` button. Every entity hovercard renders through
`ManifestCard`; it shows an image only when the entity's `toXCard` spec pushes a
`{kind: "thumb"}` block.

## Detail ledgers

Repeated read-only facts use `ui/records/ledger.tsx`; read-only record lists use
`RecordList` and its `Record*` parts (`ui/records/record-list.tsx`), which render
a records `Ledger`. `cubby/no-hand-rolled-record-list` rejects hand-rolled
divided lists.

- `Ledger` chooses facts (`dl`) or records (`ul`); compose `LedgerRow` with
  `LedgerCell` slots for leading identity, primary, secondary, trailing,
  actions and expanded details. A `LedgerRow` outside a `Ledger` throws in
  development because subgrid rows lose their columns.
- The container owns column adaptation through inline-size containment, so it
  must stretch in any parent and never rely on child intrinsic width.
- Layout stays in the ledger; links, commands, choices, mutation state and raw
  diagnostics stay with the caller.
- Only a form or `data-ledger-expanded` content moves actions below the record;
  compact controls stay in the rail. Expanded forms and full-width prose span a
  lower row.
- A list whose rows carry several labelled values declares `columns`; each row
  keeps its labels in `dt` (visually hidden beside the header) for phones and
  assistive tech.
- Pinned selected cells use an opaque mixed surface; never apply a translucent
  background over it.
- Tests select the semantic facts ledger and assert real labels. Browser
  readability checks compare painted text against clipping bounds.

## Page shell

Every list and detail page renders through `Page` (`~/entity/page/page`), whose
props are a discriminated union: `variant="detail"` requires `entity`. Pages
never call `PageWrapper` directly. Detail bodies use `DetailSections`
(`~/entity/table/detail-page`) as children. Headings and disclosure follow
[shared headings](../DESIGN.md#shared-headings-and-actions). An empty portaled
table toolbar leaves no border or spacing. Run detail owns the shared agent
controls, transcript and progress presentation.

### Ordinary overlays

Use [`Overlay`](../src/ui/overlays/overlay.tsx) for modal workflows and workspace
panels; [DESIGN.md](../DESIGN.md#component-sources-and-boundaries) owns its
presentation and submission lifetime. Pass actions directly from the owner;
forms use a shared native form id. Command, photo and modeless inspector
surfaces keep their own engines.

## Work page

`/activity` is the Work page: a health line, a Stuck section only when something
is stuck, the Needs you queue, then links to Suggestions, Missing facts, All work
and History (`/history`, Run history and recorded Changes). It answers whether
background work is healthy and what needs a member, with no scheduler or queue
vocabulary (wakes, leases, tickets, deadlines, pace, refresh counts); telemetry
belongs to `/jobs`, Run and Job pages, and MCP.

- The health line states Healthy, Catching up, Stuck or Unknown, never a count of
  internal work, percentage or ETA. A failed read says the page cannot tell, with
  raw diagnostics and Try again, and never claims all clear.
- Stuck rows show an outcome title, one sentence on consequence or remedy, at
  most one action, and a closed Technical details disclosure with the raw
  failure and Copy. Eight rows show first; Show more reveals the rest in place. A
  retry rereads every 10 seconds for two minutes, then stops.
- Needs you is the embedded `WorkQueue` grouped by Reason over
  `NEEDS_YOU_FILTERS`, the same population as the sidebar and Home. Empty, it
  reads `Nothing needs you.`; with incomplete inputs it shows the known-work
  notice instead, because an unknown source cannot be claimed empty. Source and
  Problem keys never reach the member.
- When the published queue's last republish failed or its rows are over ten
  minutes old, Home, Work and the full queue add one line: "Needs you last
  updated <relative time>", "; the latest update failed" when it did, a closed
  Technical details disclosure with Copy, and Retry. The rows stay.
- The sidebar Work row shows the needs-you count and, only when something is
  stuck or the count is behind, a static warning glyph; the collapsed rail shows
  one dot with the same label. Healthy work shows nothing at any backlog size, a
  failed read stays silent, and the read never polls.
- Run types is the "What does each Run do?" reference: targets, exclusions,
  effects, dependencies, cost and recovery, with ordered steps reusing
  declaration labels. Static definitions forecast; Run and Job evidence stays
  canonical. Execution details sit behind a technical disclosure, and Job/Run
  headers link to their definitions.
- Settings → Maintenance keeps the daily pass and repair tools behind a closed
  disclosure, so opening Settings reads no maintenance status. Recipe re-parsing
  and alias pruning require a successful preview before Apply; each
  Current/Proposed sample states its coverage, and the server rechecks
  eligibility at Apply. Repair comparisons span the width below the description.
