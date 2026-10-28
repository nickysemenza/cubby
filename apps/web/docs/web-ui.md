# Web UI contracts

Plain-date editors use `DatePickerInput`: typed calendar dates and English
expressions such as `1 year ago`, with a calendar alternative. Relative days,
months and years resolve at commit time in local calendar time; month ends and
leap days clamp to a valid day. Invalid or out-of-bound drafts remain visible
without replacing the committed value.
Keep selected inspector values with the page's selection owner when responsive
layouts move an editor between a sidebar and sheet; the layout change must not
reset action parameters.

All human record dates, timestamps, and declared date ranges render through
`DateDisplay` (`ui/common/date-display.tsx`): outside tables the absolute date
includes the year and, for an instant, its clock time, followed by a muted
relative distance separated by a middle dot ("Oct 13, 2026, 11:50 AM · 2 minutes
ago"). The instant is formatted in the household zone. Plain days never convert
through UTC; their distance compares household calendar days, including DST.
Today, yesterday, tomorrow, and ongoing ranges retain those labels. Fully ended
ranges use their end for relative context; future ranges use their start.

Shared report record rows can opt into inline relative age
with `showRelativeTime`; Shipment tracking timelines use this full date display.
Inside desktop tables, the component stacks the month/day over a muted
compact distance ("Oct 13" / "3 min ago"). Minutes use `min`, months use `mo`,
with a space before both, so neither can read as the other. Another year leads
the compact distance line ("’25 · 1y ago"). Timestamp tooltips on hover and
keyboard focus expose exact seconds and the household timezone offset.
`DenseCellContext` selects the table form; static tables opt in with `stacked`.
Full labels wrap rather than clip on narrow screens. Date columns start at
96px and declared spans at 320px; shared rendered-content fitting preserves
readable labels.
Within a query scope, unchanged rendered cells retain their measured contribution;
content changes invalidate only the affected cell. New cells and font readiness
receive fresh measurements, and a new query scope resets the fit.
Mutations without an eligible unmeasured cell skip geometry reads as well as
offscreen cloning, so unrelated enrichment cannot force a fitting layout.

Desktop table cells containing `DateDisplay`'s open-overdue marker use the
destructive surface tint across the cell. Keep the overdue text as a second
signal, and let the shared date/status logic clear both when work is settled.
The deadline tint stays visible through row hover and selection; selected cells
retain a ring outline so selection does not depend on the background.

Mounted record labels share `useDisplayNow`, refreshing once per minute and on
focus/visibility changes, including household midnight and sleep/wake; they do
not depend on a query refetch. `formatTimestamp` and `formatDateSpan` supply the
same full label for string-only captions. Keep dates absolute in record names,
persisted evidence, or narrative sentences that already describe their relative
context (overdue/quiet periods or uncertain/open chart intervals); relative ages
must not enter AI evidence or be repeated mid-sentence. Task summaries pass the optional end
so an ongoing window cannot collapse to a past start day. Browser checks verify
unclipped labels rather than only matching DOM text. `formatCalendarDay` and
`formatInstant` remain absolute primitives for editable date inputs,
calendar/chart axes and headings, month labels, and fixed-format diagnostics.

Use style tokens—never component hardcoded colors. Semantic color additions get
both `:root` and `@theme inline` mirrors. Use `size-N` icon sizing (inline/nav
`size-3.5`, card/tile `size-5`) and the `Badge` primitive for categorical chips.
A declared enum field renders as an `EnumPill` through one roster: the
option's compiled `role` picks `StatusValue` (glyph, tone surface, full ink)
or `CategoryValue` (quiet option-tinted surface, foreground label, colored glyph), and
booleans render as `BooleanValue` (check / muted dash). The roster is
`enumFieldOptions`/`enumFieldLabel` (`apps/web/src/entity/display/enum-field-display.tsx`), on
every surface — generic list cell, embedded relation table, detail value, hero
chip, previews — and is inline-editable wherever the entity has an update
command. Never read `control.options` directly for a label, and never add a
hand-written column for an enum: declare shared labels/colors in
`control.options` or `display.valueOptions`, including each option's `glyph`
(Phosphor name + SF Symbol; the web map is `ui/common/option-glyph.tsx`), and
declare width/mobile on the field instead. `ENTITY_SELECT_OPTIONS` holds only
web editor sentinels.
Every `<Image>` declares `displayWidth` as the box's true maximum rendered CSS
width (widest breakpoint), never a guess or a rung: the helper fetches 2× and
snaps up to 128/640/2048, so declaring 400 for a ~225px card fetches the 2048
rung. Prefer image wrappers.

Use the guarded spacing scale and `Row`, `Stack`, `Grid`, `Section` when the
layout repeats or encodes a real decision. `gap` is for flex/grid siblings;
`space-y` is for plain block stacks. Dense exceptions are rare `/* tight */`.

Every value choice renders through the one `Picker`
(`ui/combobox/picker.tsx`); `PickerField` (`entity/forms/picker-field.tsx`) is
its only react-hook-form binding. Native `<select>` (`cubby/no-native-select`)
and raw Base UI combobox/select/toggle-group or the toggle-group primitive
(`cubby/no-raw-value-control`) are banned outside it. Choose the mode
explicitly: `search` (text input, filter or server search, create) for records
and long lists; `choose` (Base UI `Select`: arrows, Home/End, letter typeahead,
no soft keyboard) for a short fixed list; `segmented` (inline button group) for
a handful of view modes or formats. `multiple` keeps several values as chips;
`footer` pins Clear/Apply for a draft filter. String choices pass `options`
(`PickerOption`); records pass `items` with an `entity`, built by
`combobox-builders.tsx` from the manifest — `displayImages[0]` is the picture
and the phone-row projection (`display.mobile` `subtitle` and `trailing` slots)
supplies the secondary/status and trailing columns, so declare those slots
rather than hand-building row content. Each mode and `PickerField` store keeps
its own value, empty value, focus, and search contract. A picker never displays
or announces a shortcode: a stored code resolves to its record through
`useSelectedPickerItems`, showing a loading state meanwhile. `DropdownMenu`
and the `cmdk` command menu are for navigation and actions, never a value.
Reference displays whose projection omits the name use the shared by-id
resolver instead of rendering the stored identifier. Pending reads show loading;
missing records and failed reads remain explicit, with raw error diagnostics.
Inventory and cookbook shortcodes retain their individual detail destinations;
legacy UUID audit references keep their unlinked/index fallback.
Visual rules live in [DESIGN.md](../DESIGN.md#controls-and-suggestions).
Suggestion proposals, alternatives, and correction evidence use the canonical
suggested-field renderer on detail pages and in table reviews. References keep
their record links and domain pills; plain text and explicit None retain their
own presentation. Proposed values never borrow the current record's resolved
values, reference labels, or allocations. Declared enum options retain their
canonical labels and pills even when a suggestion supplies a display label.
Acceptance controls keep their existing interaction; linked review values navigate
to their records.
Record picker builders add up to two declared metadata values as a searchable
secondary line. Trailing picker figures use their content width, capped at
7.5rem, so compact counts do not reserve a full metadata column and squeeze
inline filter labels.
The check and name weight indicate selection; the row fill
indicates pointer or keyboard highlight. Desktop record popups show keyboard
hints when a caller has not supplied a footer.
The picker's frame owns its focus ring. Its nested search input suppresses
the standalone input shadow and border so focus never stacks two outlines.
On phones, inline suggestion marks reserve their 44px target in layout.
Invisible hit-area expansion must not cover adjacent edit or relation controls.

Search-mode empty results use the mounted Base UI `Combobox.Empty` part,
with conditional children for loading and errors. A plain empty-state element
does not register the popup's empty state and lets Escape close its parent
dialog. Keep the library's live region mounted and test dismissal through the
real dialog journey.

Use `RTable` for interactive lists and review queues, and `StaticTable` for
simple read-only summaries, reports, comparisons, and form previews. Links and
bounded form actions may live in static cells; search, filters, sorting, row
navigation, and inspection belong to `RTable`, not a second list implementation.
Bounded non-entity lists use `useLocalTable` for client-side search/filter/sort
and the shared column layout. Its search accessor may include evidence absent
from displayed columns; table metadata declares that search to the shared
filter controls. Complete local data may supply result and opted-in facet
counts; a server page must never masquerade as the full result set. The local
table's `totalCount` identifies truncated source reads and suppresses those
counts; its caller labels the loaded scope. The table does not read or write
the page's URL state.

Declared `display.columnGroup` labels form quiet desktop header bands above
the ordinary sortable/filterable column headers. Shared identity columns stay
outside the bands. Columns in a band remain contiguous: reorder members within
their band, move whole bands earlier/later in Columns, and pin/unpin all members
together. Group Show/Hide changes the member columns' visibility; individual
visibility controls still work. A group with no visible members has no header.
Layout application also repairs interleaved groups and split pin regions.
These controls use the existing session-only column layout and Restore defaults.
Phone cards keep their existing composition; Columns offers the same groups.
Related-preview columns declare the same `columnGroup` in the related-view
presentation registry; their data loading remains with the existing shared
related-preview pipeline.

Every entity list declares its thematic bands with its own fields. Catalog and
stock facts, purchasing and settlement, work and dependencies, and execution
and results stay distinct. Custom relation columns join the same bands through
the shared column helpers. Identity, quality, images, and audit timestamps remain
outside thematic bands; narrow lists may have just one band. Embedded entity
tables inherit the target fields' bands for the columns they expose.

`display.columnBar` supplements a numeric cell with absolute magnitude against
the largest absolute value across the table's loaded, filtered rows, before
pagination. Loading more rows can change this scale. The signed, formatted value
and clipboard data remain authoritative; refunds are never clamped to zero.
Zero and unavailable values have no bar, and non-table values keep plain text.
The scale and loaded scope are available on hover and to assistive technology.
Opt in for comparable monetary values, counts, durations, calories, or file sizes.
Do not compare quantities with different units or fabricate trend samples,
targets, or coverage denominators from a scalar total. A bar is magnitude, not
completion or a judgment that a larger value is better.

Inventory relation cells keep location and quantity in the two-line dense row
budget. Supplemental stock context is available as hover and accessible text
when a location is present; outside dense tables, or without a location, it
remains visible. A third status line must not overlap the next row.

`RTable`'s `inspector` composes the shared `SidePanelLayout`: a right column at
wide widths and the shared sheet below, including embedded detail sections.
Its content receives table row stepping over the filtered/sorted row model;
domain presenters own evidence and actions. `desktopInspector` remains the
docked slot for entity-list hosts whose shared inspection owner already
handles responsive presentation and navigation. Bulk selection and the
inspector's current row remain independent.
An open inspector owns Escape before the grid resets cell selection. Nested
links, buttons, and ARIA controls own their clicks and keys, including SVG
icon targets; they must not also activate the row. A phone row's own
`role=button` is the row activation surface, not a nested control.

An opt-in `printable` RTable renders its filtered/sorted loaded rows and open
row details through `StaticTable`, outside the virtualized screen pane. This
preserves shopping-list printing; it does not fetch unloaded server pages.

`StaticTable` shares the table atoms with `RTable`, including accessible native
table attributes. Use its columns, conditional visibility, row headers,
row styling, and cell props for static reports rather than hand-writing a
body. Spanning cells may return null cell props for covered cells. Do not add
filtering, navigation, or inspection state to `StaticTable`.

Table primitives/raw tables remain for actual matrices, spanning dependency
grids, authored document tables, and loading skeletons. Debug reports use
`StaticTable` too; being diagnostic is not an exception. `useTableColumnLayout` owns
table order/pinning/visibility/sizing. Grid wrappers around tables use a
zero-minimum track (`grid-cols-1`) so wide columns scroll inside the table
instead of expanding the page. Decorated cells render through
`CellFrame`; don't append icons beside a cell value by hand. Hover-only
controls (explanation, relation workbench, resolution marks) use `CellFrame
overlay` and reserve no width; they mount only in the hovered or focused cell
and stand aside (transparent, click-through) over clipped text, where the cell
spill draws them after the full value. A derived value reads muted and
suggestion marks stay in flow. Rich reference cells put their edit pencil in
that same `CellFrame overlay` rail so it cannot intercept a category link or
`ChipCluster` overflow control. One-line chip lists use `ChipCluster
lines={1}` (first chip, "+N" with a tooltip naming the rest). Table headers paint a field's `display.columnLabel`, count icon
(`entity/column-header.ts`), or linked entity's icon (`meta.linksTo`). Two-line
cell content uses `StackedValue`, `ChipCluster`, or a shared component's dense
form (`DenseCellContext`), and clipped codes use `MiddleTruncate`. Rendered entity names are linked and
readable: use `EntityRefLink` (all record links, one component with variants), a titled truncated link, or `createNameColumn`
in RTable. Audit history can retain retired entity kinds; icon lookup tolerates
absent metadata and leaves those references unlinked. Pages use the `Page`
shell; detail bodies use `DetailSections`. Repeated read-only fact and record rows use `ui/common/ledger.tsx`; preserve their native description/list semantics and keep interactions with the caller. Scalar captions wrap within the value slot and actions stay in the trailing rail. An empty portaled table toolbar leaves no border or spacing above the records.

Record lists fill their available width, including inside a flex fact value;
their size-contained ledger must not rely on intrinsic width from its children.
Record ledgers without leading media keep prose in the capped identity track,
leaving readable space for secondary evidence and next actions; narrow containers
stack that evidence beneath the identity. A list whose rows carry several
labelled values declares `columns`: its own `columns` ledger variant places each
fact explicitly from inline custom properties, gives the identity a
`minmax(8rem, 1fr)` track instead of the 16rem cap, and keeps its labels in
each row's `dt` (visually hidden beside the header) so phones and assistive
tech read them.

Every RTable identity/name cell contains one line of name text, never a caption,
subtitle, account pill, or other content below it. Put secondary facts in their
own columns or review evidence. `createNameColumn` has no caption option;
the desktop identity-cell context suppresses shared stacked secondary values
and record-link metadata. Custom identity renderers follow the same rule.
Shelf cards retain their declared subtitles; the native `list.titleSubtitle`
setting does not affect web tables.

Column factories reuse module-level render components for selection controls:
`flexRender` treats callbacks as React component types, so refreshing column
metadata must not remount a focused row or header checkbox.
Standard editable cell renderers also retain their identity when filter rosters
or related-column metadata refresh; open drafts and focus survive those reads.
Presentation preferences that change independently of row data reach cell
renderers through React context. Recreating column closures alone does not
update memoized desktop rows; do not remount the table to refresh its visuals.

Component traps that typecheck cannot catch: `DropdownMenuLabel` crashes at
runtime unless wrapped in `DropdownMenuGroup` (Base UI, not Radix). A column
`cell` that depends on separately-fetched data must read `row.original` in the
renderer, never `info.getValue()` — TanStack Table freezes accessor results in
`row._valuesCache` and rebuilds rows only on data changes. Every entity
hovercard renders through one `ManifestCard`; an image appears only when the
entity's `toXCard` spec pushes a `{kind: "thumb"}` block.
Base UI `useRender` wrappers retain their default tag's prop types; put
button-only props on the button supplied through `render`.

For component-level exceptions and examples, load the relevant heading in [the
preserved web UI reference](web-ui-reference.md).

## Technical representations

Use `InspectableValue` (`ui/common/inspectable-value.tsx`) for explicitly chosen
readable/raw pairs. Keep the readable label visible with a dotted underline;
hover or keyboard focus reveals the exact raw value, and click/tap keeps the
popover open for selection and Copy. Escape and outside interaction dismiss it.
Pass the exact technical string rather than reconstructing it from display text.
Do not hide essential facts, wrap existing buttons/links, or automatically make
every field inspectable. Run types and run timeline reason, phase and input-mode
labels use this shared component; standalone technical facts remain visible.

### Record link appearance

`EntityRefLink` renders a record pill by default. Use `bare` for table name
columns. The shared pill owns image size, text, fallback marks and wrapping;
entity declarations own labels and identity data. Candidate filter rows reuse
the same noninteractive identity, with detail and counts outside the pill.
Resolve canonical display images in batches at collection boundaries and pass
them through the display-image provider, including transitive images. Never
start an image or record-mark metadata query from a cell or option row. Use
identity metadata already supplied by the owner; a missing mark falls back to
the canonical entity mark.

Detail identity headers use the canonical display-image resolver when the local
gallery is empty, including Vendor logos and inherited Product Brand images.
Resolve that cover at the page boundary, not from the thumbnail. Eligibility
follows image storage and display bindings, including logo storage; the legacy
`hasImages` gallery/cover trait does not gate identity imagery. Keep the Images
section limited to the record's own gallery; borrowed covers do not become
attachments. A header with a thumbnail omits its duplicate generic title mark.

### Record pill display images

`EntityPill` uses the shared canonical display-image context, including borrowed
images along declared relationship paths. Collection owners prepare image refs
for their loaded rows through `EntityDisplayImagesProvider`; audit feeds do this
for all loaded entries. The shared app provider collects otherwise-uncovered
mounted references into the same chunked resolver. Pills register references,
never own a query. Explicit collection batches retain ownership and seeded null
results remain authoritative. Records with no eligible image retain their mark.

Home Meals and record-backed work rows use `EntityRefLink` pills with collection-owned
image batches. Queue review links retain their Suggestions destination. Source
transaction records borrow canonical images through accepted transaction evidence.
A unique supported merchant suggestion supplies a later decorative Vendor logo
fallback; ambiguous and insufficient history retain the semantic mark.

Calendar grids, span chips, agenda rows and the day sheet share one display-image
provider for the loaded range. The server resolves `displayImages` for every item type in one range batch.
The month grid uses compact single-line pills, identity marks and desktop
controls with caption-sized labels. Its lane CSS variables also drive placement
and drag geometry; density changes never scale painted chips separately from
their slots. Phone navigation keeps the shared touch-target floor.
The grid and day sheet seed the shared context from that response.
Compact span rows show a small thumbnail when available; missing images retain
the kind icon. Opening the day sheet does not create a separate image query.
Calendar spending rows convey refunds through their negative amounts without a
separate Refund badge.

All record identity imagery uses the canonical resolver. Raw attachment galleries,
Product image summaries, nested identity-product photos, and direct logo/cover
joins must not select a second identity image. URL-only picker projections remain
serializers of canonical results. Location trees carry canonical media for the
whole loaded tree; child photo contact sheets remain explicit compartment evidence
and never become a parent identity fallback. Recipe heroes and comparisons, Wish
candidates, Arrange, tools, and Location contents use the same image context.
`useEntityDisplayImage` accepts a known canonical seed so a projected image or
explicit no-image result does not register another request with the shell batch.

The same contract applies to native typed consumers: Location lists read the
tree’s canonical media, and recount Products receive canonical media in the
shared inventory read batch. Neither client reconstructs identity from galleries.

### Activity work feed

Now owns current work state, pace and watchdog explanations. Internal Job kinds
stay out of the member-facing stream list; derived drain health attaches to
Derived values. Raw watchdog evidence is collapsed under Watchdog details.
The live header dot is static for reduced motion; an idle feed reads All quiet.
Run codes are spaced, capped at three with a +N remainder, and share a command
line below the secondary text on phone. Run evaluation bars compose ProgressLabel
and ProgressValue; inactive Runs show paused bars without a rate or ETA.
