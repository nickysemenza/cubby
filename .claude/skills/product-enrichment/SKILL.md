---
name: product-enrichment
description: Enrich Cubby products with verified cover images, UPC/EAN/GTIN barcodes, manufacturer models, Amazon ASINs, retailer identifiers, names, categories, manufacturers, and current prices. Use when the user wants to fill missing product images or details, burn down the stocked-product image backlog, enrich specific Products created or identified during purchase import, research products from model numbers or external IDs, or correct product metadata from authoritative product pages.
---

# Enrich Cubby products

Add product facts and one representative cover image through Cubby's existing
MCP tools. Keep the work interactive: there is no enrichment queue or separate
evidence table, so return a source-backed batch report when finished.

## Build the worklist

When the caller or purchase-import handoff supplies specific `PRD-` shortcodes,
use those Products as the worklist regardless of inventory presence. Enrichment
does not decide whether a receipt line deserves a Product and never mints one;
the import workflow owns that promotion decision. A Product does not need to be
received into inventory before enrichment.

For a general stocked-product backlog sweep:

1. Call `search_products` with:
   - `inventoryPresenceFilter: "has"`
   - `imagePresenceFilter: "none"`
   - `sort: "identity_strength"`
   - `pageSize: 25`
2. The server ranks strongest identities first:
   - UPC/EAN/GTIN;
   - ASIN or another exact external ID;
   - manufacturer plus model/MPN;
   - model/MPN alone;
   - name-only products last.
3. Treat `imageCount` as the displayable-image count and `coverImageUrl` as the
   current cover. PDFs do not count. Skip attachment when `imageCount > 0`
   unless the user explicitly asks to replace or expand the gallery.

## Resolve exact identity

Use this evidence order and stop when the exact variant is proven:

1. Open an existing `externalIds[].url`; for an Amazon ASIN, derive
   `https://www.amazon.com/dp/<ASIN>` even when `url` is null.
2. Try deterministic UPC lookup when a UPC is already known.
3. Search the manufacturer's site using manufacturer plus model.
4. Search a reputable retailer using the exact model or retailer SKU.
5. For Amazon, open `https://www.amazon.com/dp/<ASIN>` in the signed-in
   in-app browser or Chrome session. Confirm the selected size/color/count
   variant; an ASIN for a parent or neighboring variant is not proof.
6. Use aggregators and general search only to find a primary page. They are not
   sufficient by themselves to overwrite populated names or prices.

Do not treat a cached UPC record with no image as a completed lookup. Continue
through manufacturer, retailer, and browser sources. Do not generate a product
image with AI; attach a real image of the exact product.

Always attempt to capture the canonical identifiers exposed by the source:

- Copy an exact published UPC/EAN/GTIN into `upc`. Preserve all leading zeroes
  and the published 8, 12, 13, or 14-digit representation. Never derive one
  from a model or SKU.
- Put the maker's model/MPN in `model`.
- Put an Amazon ASIN in `externalIds` with `source: "amazon"` and `kind: "asin"`.
  Omit `url`: Cubby derives the canonical `/dp/<ASIN>` URL on output instead of
  storing the same identity twice.
- Put retailer-specific SKUs in `externalIds` with `kind: "retailer_sku"`, not
  `model`. Use `internet_number`, `item_number`, or `catalog_number` only when
  that is how the source labels the identifier. Never relabel an existing
  `legacy_unspecified` slot without source evidence.
- Use a canonical lowercase kebab-case source slug (`home-depot`, not
  `home_depot` or `Home Depot`). A `(source, kind, externalId)` tuple can belong
  to only one live Product, and each Product can carry only one value in a
  `(source, kind)` slot.
- Never invent a plausible-looking identifier or silently choose among
  variants. Skip ambiguous products and report the conflict.

The manufacturer is part of identity. Same-name merchandise from different
brands is normally different Products: SupplyHouse `PVBC100-075` and `429-131`
are separate products with separate brands, not two retailer slots on one
record. Put maker-issued model/MPN in `model`; retailer SKUs belong in typed
`externalIds`.

## Apply metadata safely

Read the current product immediately before writing. Use
`patch_product_external_ids` for identifier-only changes: upsert a precise
`(source, kind)` slot and remove only an explicitly obsolete slot with its
exact `expectedExternalId`. It preserves all unrelated identifiers and refuses
the whole patch if the live slot changed. Use `update_product.externalIds` only
when intentionally replacing the complete set; if so, preserve every desired
identifier and remove MCP-only timestamps.
When a researched item is absent, create it once with rich `create_product` or
`create_products`: include manufacturer, model, category, aliases/tags, notes,
expected quantity, price/mappings, UPC/FDC link, and verified external IDs.
Do not create then update merely to add those fields. Product creation does not
receive the item into inventory.

Before adding an identifier, call `find_product_external_id_collisions` in exact
mode with `identifiers: [{ source, kind, externalId }]`. A `collision` requires
manual resolution; `unique` names the current owner; `missing` is safe to add to
the proven Product. Keep broad source-wide audits separate from exact checks.

All metadata is eligible for correction only when exact-variant evidence is
authoritative for that field:

- Prefer manufacturer pages for manufacturer, model, canonical name, and
  category.
- Use an exact retailer page for UPC, retailer SKU, image, and a current offer.
- Do not replace a concise correct name with a retailer SEO title.
- Treat `price` as an explicit current/replacement-price override: setting it
  intentionally takes precedence over the Expense-derived average, while
  clearing it resumes that fallback. Replace it only with a currently visible
  exact-variant offer sold directly by the manufacturer or retailer. Ignore
  marketplace third-party offers, crossed-out list prices, aggregators, and
  inferred averages. Historical receipt quantities belong on the linked
  Expense's `productQuantity`, not in a manual Product price.
- Never blanket-apply a provider response. Compare and write fields
  deliberately.

## Attach one cover image

Choose one clean representative image, preferring the manufacturer asset and
then an exact retailer asset. Reject lifestyle shots, bundles, watermarks,
wrong colors/sizes/counts, thumbnails, and images whose variant cannot be
confirmed.

Before attachment, perform a bundle checkpoint: confirm the page and image show
the exact standalone Product, not a kit, multipack, accessory, or family page.
If an exact listing is retired, bundle-only, variant-ambiguous, or has no
canonical image, do not attach a substitute. Preserve the verified identity
facts, record the supported image exception in the report, and leave the gallery
unchanged. A manufacturer family image is allowed only when disclosed as such
and useful to the user.

Read `get_product` immediately before attachment and snapshot its images,
cover, display order, count, and metadata. Call `attach_file` once with the
product's `PRD-` shortcode, `expectedImageCount`, and a deterministic retry
key:

`product-enrichment:<PRD-shortcode>:<source>:<kind-or-purpose>:cover:v1`

1. Prefer `url` so Cubby fetches and stores the source image in R2.
2. If the source blocks Cubby's server fetch, download the verified asset
   through the signed-in browser and pass its bytes as base64 `data` with the
   correct `contentType`.
3. Do not attach a second image in the same enrichment pass.

Retry the same logical attachment with the same `idempotencyKey`. A count
precondition failure means another writer changed the gallery: re-read the
Product and decide from the new state instead of incrementing the expected
count. For cover replacement, never detach the old cover first.

## Verify every write

Call `verify_product_images` after attachment and use its returned detailed
Product rather than making a redundant immediate `get_product` call. Confirm
the gallery is the snapshot plus the new verified file. Only then send one
`update_product` with any `removeImageIds` and complete `imageOrder`; call
`verify_product_images` again after that change. Confirm:

- UPC, model, manufacturer, metadata, and every prior external ID survived;
- image count, `coverImageId`, `isCover`, and display position match the
  intended final gallery;
- intentionally removed old cover IDs are absent and unrelated file metadata
  survives;
- the new image has a one-based `displayPosition`, passing render/storage
  integrity, dimensions, detected MIME, and SHA-256 metadata;
- PDFs and failed-integrity files have `displayPosition: null` and do not count;
- the product still describes the exact researched variant.

If any verification differs from the expected snapshot, stop that product and
report gallery drift. Do not continue on the assumption that an attachment or
mutation response succeeded.

Prefer an adequate-resolution exact image. If the only reliable source is
low-resolution, use it only when useful and disclose the limitation. A shared
family/series image is acceptable only with an explicit disclosure that it is
not exact-item photography. Never guess CDN URLs. An image-complete Product is
not necessarily fully enriched: report unresolved model, barcode, price, or
identifier gaps separately. Receiving a durable Product remains an explicit,
user-authorized inventory action.

## Report the batch

Return a compact table with one row per candidate:

| Product | Identity used | Source page(s) | Fields changed | Image | Outcome |
| --- | --- | --- | --- | --- | --- |

Use `enriched`, `skipped — ambiguous`, `skipped — no exact source`,
`skipped — retired/bundle-only/no canonical image`, or `failed — <reason>` as
outcomes. Include direct source links and any supported image exception in the
report; Cubby's normal audit log remains the durable record of field writes.
