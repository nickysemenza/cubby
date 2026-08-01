---
name: product-enrichment
description: Enrich Cubby products with verified cover images, UPC/EAN/GTIN barcodes, manufacturer models, Amazon ASINs, retailer identifiers, names, categories, manufacturers, and current prices. Use when the user wants to fill missing product images or details, burn down the stocked-product image backlog, research products from model numbers or external IDs, or correct product metadata from authoritative product pages.
---

# Enrich Cubby products

Add product facts and one representative cover image through Cubby's existing
MCP tools. Keep the work interactive: there is no enrichment queue or separate
evidence table, so return a source-backed batch report when finished.

## Build the worklist

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

## Apply metadata safely

Read the current product immediately before writing. Use
`patch_product_external_ids` for identifier-only changes: upsert a precise
`(source, kind)` slot and remove only an explicitly obsolete slot. It preserves
all unrelated identifiers and is safe for concurrent changes to other slots.
Use `update_product.externalIds` only when intentionally replacing the complete
set; if so, preserve every desired identifier and remove MCP-only timestamps.

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
- Replace `price` only with a currently visible exact-variant offer sold
  directly by the manufacturer or retailer. Ignore marketplace third-party
  offers, crossed-out list prices, aggregators, and inferred averages.
- Never blanket-apply a provider response. Compare and write fields
  deliberately.

## Attach one cover image

Choose one clean representative image, preferring the manufacturer asset and
then an exact retailer asset. Reject lifestyle shots, bundles, watermarks,
wrong colors/sizes/counts, thumbnails, and images whose variant cannot be
confirmed.

Read `get_product` immediately before attachment and record its current
`imageCount`. Call `attach_file` once with the product's `PRD-` shortcode,
`expectedImageCount`, and a deterministic retry key:

`product-enrichment:<PRD-shortcode>:<source>:<kind-or-purpose>:cover:v1`

1. Prefer `url` so Cubby fetches and stores the source image in R2.
2. If the source blocks Cubby's server fetch, download the verified asset
   through the signed-in browser and pass its bytes as base64 `data` with the
   correct `contentType`.
3. Do not attach a second image in the same enrichment pass.

Retry the same logical attachment with the same `idempotencyKey`. A count
precondition failure means another writer changed the gallery: re-read the
Product and decide from the new state instead of incrementing the expected
count. For cover replacement, attach and verify the new file before sending
`removeImageIds` and `imageOrder` through `update_product`; never detach the old
cover first.

## Verify every write

Call `verify_product_images` after attachment, then call `get_product`. The
detailed Product read returns `coverImageId` and every Product file in
`images[]`; it does not contact R2 by itself. Confirm:

- UPC, model, manufacturer, metadata, and every prior external ID survived;
- `imageCount` increased by exactly one for a previously image-less product;
- `coverImageId` and `coverImageUrl` identify the intended file;
- the new image has a one-based `displayPosition`, passing render/storage
  integrity, dimensions, detected MIME, and SHA-256 metadata;
- PDFs and failed-integrity files have `displayPosition: null` and do not count;
- the product still describes the exact researched variant.

If verification fails, stop that product and report it. Do not continue a
batch on the assumption that the MCP response or attachment succeeded.

## Report the batch

Return a compact table with one row per candidate:

| Product | Identity used | Source page(s) | Fields changed | Image | Outcome |
| --- | --- | --- | --- | --- | --- |

Use `enriched`, `skipped — ambiguous`, `skipped — no exact source`, or
`failed — <reason>` as outcomes. Include direct source links in the report;
Cubby's normal audit log remains the durable record of field writes.
