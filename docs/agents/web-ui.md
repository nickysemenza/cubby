# Web UI contracts

Use style tokens—never component hardcoded colors. Semantic color additions get
both `:root` and `@theme inline` mirrors. Use `size-N` icon sizing (inline/nav
`size-3.5`, card/tile `size-5`) and the `Badge` primitive for categorical chips.
Every `<Image>` declares `displayWidth` as the box's true maximum rendered CSS
width (widest breakpoint), never a guess or a rung: the helper fetches 2× and
snaps up to 128/640/2048, so declaring 400 for a ~225px card fetches the 2048
rung. Prefer image wrappers.

Use the guarded spacing scale and `Row`, `Stack`, `Grid`, `Section` when the
layout repeats or encodes a real decision. `gap` is for flex/grid siblings;
`space-y` is for plain block stacks. Dense exceptions are rare `/* tight */`.

Use `RTable` for interactive lists, Table primitives for static tables, and raw
tables only for matrices/debug/external content. `useCubbyTableLayout` owns
table order/pinning/visibility/sizing. Rendered entity names are linked and
readable: use `EntityInlineLink`, a titled truncated link, or `createNameColumn`
in RTable. Pages use the `Page` shell; detail bodies use `DetailSections`.

For component-level exceptions and examples, load the relevant heading in [the
preserved web UI reference](web-ui-reference.md).
