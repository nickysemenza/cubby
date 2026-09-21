---
name: photo-inventory-import
description: Import user-requested household belongings or wardrobe photos into Cubby through a local manifest, preserving evidence, ownership, locations, and duplicate decisions.
---

# Photo inventory import

Use this skill for a user-requested photo batch of owned belongings or clothes.
Read [the import guide](../../../docs/agents/photo-inventory-import.md) before
writing. Keep the manifest outside the repository. It records originals and
their SHA-256/capture order, groups and roles, duplicate decisions, intended
Product/inventory fields, and the append-only write ledger.

## Group and describe

Group from adjacency plus visible and label evidence. Preserve originals and
order. Keep `dupefile`, `additionalview`, and `physicalcopy` distinct: only the
last represents another owned instance. Flag unsupported videos separately; never treat a skipped video as imported.
Keep original label text as evidence;
image analysis describes visible content and must not guess fabric or replace a
Product name. Put size in the name and attributes in tags.

Create descriptive Products for clear items in the requested batch, even when
brand or model is unknown. Route uncertain groups to exception review. Verified identical variants may share a Product. Count each physical copy once;
copies with the same owner and location may share an inventory quantity.
Use one existing root/group/type reference; never create taxonomy choices during
import without an explicit user decision. The initial Apparel choices are
Shoes (sandals, sneakers, heels, boots), Clothes (shirts, shorts, pants,
jackets, skirts, sweaters, dresses), and Accessories (purses, belts, hats).

## Commit safely

Persist intended payloads before writes and returned shortcodes/readback after.
For local folders, use `create_file_uploads({items})` (up to 50) and retain
each indexed outcome. PUT bytes for each successful presigned URL, then call
`attach_files({items})` with the corresponding `uploadId`, target Product, and
purpose. Its outcomes are also independent and indexed: keep successes, then
retry only failed items after reconciling their persisted intent and fresh
read-back. Never send local bytes or base64 through MCP.

For a Product, read it immediately before attachment and set a deterministic
idempotency key plus its complete `expectedImageCount`, which includes labels
and PDFs as well as displayable item images. Attachments to that same Product
are dependent count changes: apply them in order with a fresh count for each,
or stop and reconcile before retrying a failed index.
Create or match the Product before attaching its photos. Receive inventory
through existing operations once the Product and required ownership/location
are confirmed; image-processing completion is not a prerequisite.
The native `photoImport` pipeline requires authentic native analysis; do not
fabricate Vision feature prints or native payloads to use it. When available, schedule and inspect image work with
`schedule_image_processing` and `get_image_processing`; use
`correct_image_description` for user-confirmed corrections to retained analysis.

Use fresh Product reads for CRUD and image writes. Inventory requires a real
physical location and the confirmed existing ownership mode or owner. Ask when
ownership or location is unknown; do not create imaginary holding locations. A lost response becomes an
`uncertain` manifest entry: reconcile the exact images, Products, and inventory
entries before any retry, especially an additive inventory write.

## Images and boundaries

Own photos and confirmed catalog assets can coexist. Record Image `source`
as `own`, `catalog`, or `unknown`, catalog `sourcePageUrl`, `sourceAssetUrl`,
and `sourceName`, plus Product purpose `item` or `label`. Only verified exact-product catalog overview images qualify as enrichment
covers. Source alone is not identity verification. Preserve original files,
label photos, and manual ordering unless explicitly choosing a replacement
cover. A transparent cutout is a rendition of its original Image, not another
attachment; schedule suitable item views, skip labels and already-transparent
assets, preserve complete pairs, and allow failed processing to fall back to
the original without blocking import.

Do only the user-requested import. Do not infer prices, receipts, purchases,
vendors, composition, or purchase relationships. A later receipt is handled
through purchase import: it matches an existing Product, uses Monarch settlement
evidence only, and creates no inventory.
