# Product identity

Shared across `product-enrichment`, `purchase-import`, and
`photo-inventory-import` — the same Product may reach the catalog from a photo,
a purchase, or manual entry, and all three paths must converge on it rather
than fork it.

Name convention: `Brand Model — Color, Size` (omit a segment that does not
apply). Unknown brand: describe the item instead of guessing a manufacturer —
`Gray crew-neck workout shirt — M`, not `Unknown crew-neck shirt`. One Product
per exact variant: a different color or size is a different Product, never a
variant field on one record. Identical copies of the same exact variant are
one Product with an inventory quantity, never duplicate Products.

Match before create. Search existing Products (name, aliases, external ids,
`resolve_products`, `find_similar_entities`) before writing a new one — a
duplicate costs a merge later, a missed match costs nothing now.

A purchase claiming a photo-created Product enriches it in place rather than
creating a second record: when purchase-import resolves a line to an existing
Product whose only evidence so far was a photo, it updates that same Product
— the old descriptive name moves to `aliases`, the vendor's identifiers
(SKU/ASIN/UPC/model) are added, and the vendor's catalog image is attached
alongside the existing own-item photo. If both a photo-created and a
purchase-created Product exist for the same real item (a matching pass missed
it), resolve with `entity merge product`, keeping the purchase-created record
as `keepId` — it carries the stronger identity evidence (a paid, itemized
order) as well as the photo evidence, which the merge folds in as aliases and
attachments rather than losing it.

Cover order for a household belonging: the owner's own item cutout first, the
verified catalog image second (only once one is verified — never speculative),
labels last. This is the `Product.imageOrder` write field's ordering when more
than one source of imagery exists on the same Product; set it only when a
second source (typically the catalog image) is added after the first, not on
every write — a Product with only its own photo needs no reordering.

`dataGap: product_unpurchased` (the `product` entity's data-quality check)
lists stocked Products with no Purchase or acquiring Expense — inventoried
through a photo import but never matched to a purchase line. Use it as the
purchase-import candidate pool (`entity list product { filters: { dataGap:
"product_unpurchased" } }`, narrowed by category/owner) before creating a new
Product for an order line, and as the photo-inventory-import worklist for
Products still missing their purchase-side identity.
