# Web UI contracts

Human record dates use `formatDateSpan(day, null)` and declared ranges use
`formatDateSpan(start, end)`: retain the calendar label, omit the current year,
and append relative context for past/present/future dates (today, tomorrow, in a few
days, in about a week, in a few weeks, in about a month, in a few months,
in about a year, then approximate years). Ranges covering today say ongoing;
past dates mirror these buckets with yesterday or ago. Fully ended ranges use their end for relative context. Compare household calendar days, never elapsed hours
or UTC dates. Generic scalar dates, declared spans, and task due-date summaries
share this formatter through `CalendarDate`. Mounted labels subscribe to
`useHouseholdToday`, whose shared clock refreshes at household midnight, on
focus, and on visibility changes; cached records must not need a query refetch
to update relative context. Calendar metadata passes the same reactive day to
the pure formatter. Date columns reserve 256px and declared spans 320px so
relative context stays visible by default; full labels remain available in the
title when a column is resized narrower. Task summaries pass the optional end
so an ongoing window cannot collapse to a past start day. Browser checks verify
unclipped labels rather than only matching DOM text. `formatCalendarDay` remains the absolute primitive for
editable date inputs, calendar axes/headings, and fixed-format diagnostics.

Use style tokens—never component hardcoded colors. Semantic color additions get
both `:root` and `@theme inline` mirrors. Use `size-N` icon sizing (inline/nav
`size-3.5`, card/tile `size-5`) and the `Badge` primitive for categorical chips.
A declared enum field renders as an `EnumPill` through one roster,
`enumFieldOptions`/`enumFieldLabel` (`entities/enum-field-display.tsx`), on
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

Selection controls have distinct jobs. Use `NativeSelect` for a short, fixed
choice list that benefits from the platform picker; it owns the phone touch
floor. Use `FilterableCombobox` for a string-valued option/filter list with
type-to-filter, including server-filtered results. `StaticPicker` adapts a
fixed string-valued form choice to the entity picker's search and focus shell.
Use `EntityPicker` when a choice is a Cubby record with identity, relationship
context, server search, or creation. The `cmdk` command menu is for navigation
and actions, never a form field. Preserve each control's value, focus, and search
contract when sharing visual chrome; do not introduce a universal picker.

Use `RTable` for interactive lists, Table primitives for static tables, and raw
tables only for matrices/debug/external content. `useTableColumnLayout` owns
table order/pinning/visibility/sizing. Decorated cells render through
`CellFrame`; don't append icons beside a cell value by hand. Rendered entity names are linked and
readable: use `EntityRefLink` (all record links, one component with variants), a titled truncated link, or `createNameColumn`
in RTable. Pages use the `Page` shell; detail bodies use `DetailSections`.

Component traps that typecheck cannot catch: `DropdownMenuLabel` crashes at
runtime unless wrapped in `DropdownMenuGroup` (Base UI, not Radix). A column
`cell` that depends on separately-fetched data must read `row.original` in the
renderer, never `info.getValue()` — TanStack Table freezes accessor results in
`row._valuesCache` and rebuilds rows only on data changes. Every entity
hovercard renders through one `ManifestCard`; an image appears only when the
entity's `toXCard` spec pushes a `{kind: "thumb"}` block.

For component-level exceptions and examples, load the relevant heading in [the
preserved web UI reference](web-ui-reference.md).
