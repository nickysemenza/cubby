# Product identity

Shared across `product-enrichment`, `purchase-import`, and
`photo-inventory-import` — the same Product may reach the catalog from a photo
first, a purchase first, or manual entry, and every path must converge on one
record rather than fork it. This file is the single either-side-first
contract; the three skills point here instead of restating it.

Name convention: `Brand Model — Color, Size` (omit a segment that does not
apply). Unknown brand: describe the item instead of guessing a manufacturer —
`Gray crew-neck workout shirt — M`, not `Unknown crew-neck shirt`. A missing
or illegible tag still earns a descriptive name with color and size, never a
vaguer placeholder than the evidence supports. One Product per exact variant:
a different color or size is a different Product, never a variant field on
one record. Identical copies of the same exact variant are one Product with
an inventory quantity, never duplicate Products.

Match before create. Search existing Products (name, aliases, external ids,
`entity_read.resolve`, `search.similar`) before writing a new one — a
duplicate costs a merge later, a missed match costs nothing now.

## Either side first

A Product's identity can be established by a photo import, a purchase import,
or manual entry, in any order; whichever side arrives second must recognize
the first rather than fork a second record.

**Exact-variant identifier match** — the purchase line carries an identifier
that names exactly one variant (a GTIN/UPC, an ASIN, a retailer SKU for one
size and color, or an exact manufacturer part number) and it matches an
existing photo-created Product: resolve the line straight to that Product
(`productResolutions` `kind: "existing"`). The commit only adds the vendor's
identifiers; enrich it in place afterwards — rename to the vendor identity
with the old descriptive name moved to `aliases`, and attach the vendor's
catalog image alongside the existing own-item photo. No human review needed; the
identifier is the proof.

A style, family, or model number shared by several sizes or colors is not
identity. It ranks candidates, and size, color, or model evidence must
corroborate the exact variant; otherwise treat the pair as a descriptive-only
match below. Never store a shared style number as `retailer_sku` or any other
external id: it would claim one variant and collide with its siblings. Keep it
in `model` or `notes`.

Purchase prep only reports `exactIdentifierMatch` for identifiers stored as
external ids, never for text in `notes`. When a photo shows a legible barcode,
record it with `product_enrichment.patch_external_ids` (`source: "gtin"`,
`kind: "gtin_14"`); prep matches a numeric order-line SKU against it. A
direct-selling brand's per-variant SKU printed on its own tag may be stored as
`retailer_sku` under that brand's vendor source slug.

**Descriptive-only match** — the photo Product has no identifier (a cut tag,
an unreadable label): purchase-import does not claim it directly. Create the
purchase's own vendor Product (vendor name plus catalog image), then record
the candidate pair with `product_enrichment.propose_match`
(`{productIds: [photoProductId, vendorProductId], evidence, sourceUrls?}`)
for a human to review side by side in the web recommendations workbench.
The purchase import does not claim a descriptive-only match directly, and a
later merge requires human confirmation.

**Purchase first, photos later** — when photo-inventory-import runs after a
purchase already exists, check for the existing purchase Product before
creating: exact identifiers first, then the vendor's purchased Products
(`entity_read.relations` on the purchase's `products`, `entity_read.resolve`,
`search.similar`) for a descriptive candidate. Purchase-created
Products usually have no category and an empty manufacturer until enriched, so
never filter candidates by either.
Prioritize the exact variant with no own-item photo and no earlier photo-import
attachment; a vendor-import association is compatible with this candidate.
Read label position and context before assigning size or fit (a letter beside
"Loose Fit" may describe fit while a separate boxed letter is the size).
When brand, garment features, and variant evidence strongly favor one Product,
propose `existingId` in the photo group with the evidence and uncertainty.
The human approves that attachment. If two color or size variants remain
plausible, leave the choice for review. Create a separate photo Product only
when no existing variant fits; then use `product_enrichment.propose_match` if later
evidence connects two already-created Products.

A server detector also surfaces candidate pairs automatically from both
sides. Agents call `product_enrichment.propose_match` themselves when they hold evidence
the detector lacks — a vendor product page confirmed to match the photo, a
label transcription, an exact identifier the detector hasn't indexed.

**Merge.** A merge is always an explicit human decision. An agent that finds
a same-item pair a matching pass missed records it with
`product_enrichment.propose_match`; it never merges on its own evidence. Once
a human confirms the pair, resolve it with `entity.merge product`, which pauses
for exact typed approval in an agent run:
the vendor/purchase Product is always `keepId` — it carries the stronger
identity evidence (a paid, itemized order) plus whatever the photo
contributed. The photo Product's descriptive name folds into `aliases`, and
its images merge into the kept Product's gallery. Merge fills only the
keeper's empty scalar fields, so after merging check the kept name and
manufacturer: rename to the `Brand Model — Color, Size` convention when the
vendor title is worse.

Never receive a purchase line whose item is already inventoried from photos;
a merge or later purchase evidence is never another receipt of counted stock.
Merging two stocked Products sums their quantities, so one shirt would become
two. If the same item was received twice, ask the human to remove the
duplicate inventory entry before approving the merge.

Cover order for a household belonging: the owner's own item cutout first, the
verified catalog image second (only once one is verified — never speculative),
labels last. This is the `Product.imageOrder` write field's ordering when more
than one source of imagery exists on the same Product; set it only when a
second source (typically the catalog image, or a merge) is added after the
first, not on every write — a Product with only its own photo needs no
reordering. The match card's merge applies this order automatically; a
direct `entity.merge product` keeps the survivor's order, so set `imageOrder`
afterwards. Any Product may carry a manual override instead; a later explicit
reorder is authoritative and a subsequent automatic write must not fight it.

A catalog image may attach before any purchase exists, when a label's
SKU/UPC is legible and the vendor page is verified to be that exact variant:
set the image `source: catalog` with `sourceName`/`sourcePageUrl`. Own item
photos are always `source: own`.

`dataGap: product_unpurchased` (the `product` entity's data-quality check)
lists stocked Products with no Purchase or acquiring Expense — inventoried
through a photo import but never matched to a purchase line. Use it as the
purchase-import candidate pool (`entity_read.list product { filters: { dataGap:
"product_unpurchased" } }`, ranked by category/owner) before creating a new
Product for an order line, and as the photo-inventory-import worklist for
Products still missing their purchase-side identity.
