# Web UI contracts

All human record dates, timestamps, and declared date ranges render through
`DateDisplay` (`ui/common/date-display.tsx`): outside tables the absolute date
includes the year and, for an instant, its clock time, followed by a muted
relative distance separated by a middle dot ("Oct 13, 2026, 11:50 AM · 2 minutes
ago"). The instant is formatted in the household zone. Plain days never convert
through UTC; their distance compares household calendar days, including DST.
Today, yesterday, tomorrow, and ongoing ranges retain those labels. Fully ended
ranges use their end for relative context; future ranges use their start.

Inside desktop tables, the same component stacks the month/day over a muted
compact distance ("Oct 13" / "3 min ago"). Minutes use `min`, months use `mo`,
with a space before both, so neither can read as the other. Another year leads
the compact distance line ("’25 · 1y ago"). Timestamp tooltips on hover and
keyboard focus expose exact seconds and the household timezone offset.
`DenseCellContext` selects the table form; static tables opt in with `stacked`.
Full labels wrap rather than clip on narrow screens. Date columns start at
96px and declared spans at 320px; shared rendered-content fitting preserves
readable labels.

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
A declared enum field renders as an `EnumPill` through one roster,
`enumFieldOptions`/`enumFieldLabel` (`apps/web/src/entity/display/enum-field-display.tsx`), on
every surface — generic list cell, embedded relation table, detail value, hero
chip, previews — and is inline-editable wherever the entity has an update
command. Never read `control.options` directly for a label, and never add a
hand-written column for an enum: declare shared labels/colors in
`control.options` or `display.valueOptions` (web-only icons belong in
`ENTITY_SELECT_OPTIONS`) and declare width/mobile on the field instead.
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
supplies the inline secondary and trailing chips, so declare those slots
rather than hand-building row content. Each mode and `PickerField` store keeps
its own value, empty value, focus, and search contract. A picker never displays
or announces a shortcode: a stored code resolves to its record through
`useSelectedPickerItems`, showing a loading state meanwhile. `DropdownMenu`
and the `cmdk` command menu are for navigation and actions, never a value.
Reference displays whose projection omits the name use the shared by-id
resolver instead of rendering the stored identifier. Pending reads show loading;
missing records and failed reads remain explicit, with raw error diagnostics.
Visual rules live in [DESIGN.md](../DESIGN.md#controls-and-suggestions).

Search-mode empty results use the mounted Base UI `Combobox.Empty` part,
with conditional children for loading and errors. A plain empty-state element
does not register the popup's empty state and lets Escape close its parent
dialog. Keep the library's live region mounted and test dismissal through the
real dialog journey.

Use `RTable` for interactive lists, Table primitives for static tables, and raw
tables only for matrices/debug/external content. `useTableColumnLayout` owns
table order/pinning/visibility/sizing. Grid wrappers around tables use a
zero-minimum track (`grid-cols-1`) so wide columns scroll inside the table
instead of expanding the page. Decorated cells render through
`CellFrame`; don't append icons beside a cell value by hand. Hover-only
controls (explanation, relation workbench, resolution marks) use `CellFrame
overlay` and reserve no width; a derived value reads muted and suggestion marks
stay in flow. Table headers paint a field's `display.columnLabel`, count icon
(`entity/column-header.ts`), or linked entity's icon (`meta.linksTo`). Two-line
cell content uses `StackedValue`, `ChipCluster`, or a shared component's dense
form (`DenseCellContext`), and clipped codes use `MiddleTruncate`. Rendered entity names are linked and
readable: use `EntityRefLink` (all record links, one component with variants), a titled truncated link, or `createNameColumn`
in RTable. Audit history can retain retired entity kinds; icon lookup tolerates
absent metadata and leaves those references unlinked. Pages use the `Page`
shell; detail bodies use `DetailSections`. Repeated read-only fact and record rows use `ui/common/ledger.tsx`; preserve their native description/list semantics and keep interactions with the caller. Scalar captions wrap within the value slot and actions stay in the trailing rail. An empty portaled table toolbar leaves no border or spacing above the records.

Column factories reuse module-level render components for selection controls:
`flexRender` treats callbacks as React component types, so refreshing column
metadata must not remount a focused row or header checkbox.
Standard editable cell renderers also retain their identity when filter rosters
or related-column metadata refresh; open drafts and focus survive those reads.

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
