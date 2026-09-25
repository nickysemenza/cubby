# Web UI contracts

Use style tokens—never component hardcoded colors. Semantic color additions get
both `:root` and `@theme inline` mirrors. Use `size-N` icon sizing (inline/nav
`size-3.5`, card/tile `size-5`) and the `Badge` primitive for categorical chips.
A declared enum field renders as an `EnumPill` through one roster,
`enumFieldOptions`/`enumFieldLabel` (`entities/enum-field-display.tsx`), on
every surface — generic list cell, embedded relation table, detail value, hero
chip, previews — and is inline-editable wherever the entity has an update
command. Never read `control.options` directly for a label, and never add a
hand-written column for an enum: register rich labels/colors in
`ENTITY_SELECT_OPTIONS` and declare width/mobile on the field instead.
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
readable: use `EntityInlineLink`, a titled truncated link, or `createNameColumn`
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
