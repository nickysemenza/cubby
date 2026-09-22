---
name: product-enrichment
description: Enrich Cubby Products with verified identity facts and representative cover images. Use for missing product metadata/images, specific Products from purchase import, or source-backed corrections.
---

# Enrich Cubby products

Add proven facts and one representative cover through existing MCP tools. Keep
research interactive: there is no enrichment queue or evidence table. Return a
source-backed batch report.

## Worklist and read shape

Use supplied `PRD-` identifiers regardless of inventory. Enrichment never
decides whether an import line becomes a Product and never receives inventory.
For a backlog, `entity list product` with `sort=dataQuality` ascending puts the
weakest identity first (heavier identity checks — manufacturer, external ID —
outweigh lighter ones), in pages of 25. Narrow to a specific gap with
`filters.dataGap` on a check id: `product_manufacturer`, `product_external_id`,
`product_category`, `product_model`, `product_price`, `product_image`,
`amazon_asin`, `duplicate_external_id`. Start with summary/count reads, then
request the relevant page; request full records only for candidates being
researched.

Read a candidate immediately before every write. `imageCount` is the complete
attachment count used by upload preconditions; `itemImageCount` and
`labelImageCount` describe the split. A label-only Product still needs an item
photo. Existing own photos or labels do not disqualify a Product from catalog
enrichment. Inspect source, purpose, identity evidence, and current order before
adding another image; skip redundant catalog views.

## Research and identity

Prove the exact variant before writing: existing external-ID URL, deterministic
UPC lookup, manufacturer page, then exact retailer page. An Amazon ASIN can use
`https://www.amazon.com/dp/<ASIN>`; confirm the selected variant. General search
and aggregators may find a primary page but cannot overwrite a populated fact.
Never generate an image with AI.

Record only published evidence: UPC/EAN/GTIN in `upc` with leading zeroes,
maker MPN in `model`, Amazon ASIN as `externalIds` `amazon`/`asin`, and retailer
SKUs in their typed slot. Use lowercase kebab-case source slugs. A source/kind/
external-ID tuple has one live owner; do not invent, relabel, or choose between
variants. Ambiguity is a reported skip.

Read [source mechanics](references/sources.md) only for the source in hand.
Read [write and image rules](references/writes-and-images.md) when preparing a
write, collision, batch, kit, replacement, or verification.

## Write safely

Before enriching, check whether this Product has a merge candidate on the
other side (a photo Product for a purchase-created one, or vice versa) per
[product identity](references/product-identity.md)'s either-side-first
contract; propose it with `propose_product_match` rather than enriching two
records that should converge into one.

Use `patch_product_external_ids` for exact slot changes and preserve unrelated
IDs; use a full `entity update product` external-ID set only when deliberately
replacing it. Check `find_product_external_id_collisions` before each new ID.
A collision needs manual resolution, normally a proven merge, never a silent
reassignment.

Research individually, then batch settled writes: collision checks up to 100,
metadata/identifier/image writes up to 50, image verification up to 20. Each
item has its own precondition and idempotency key. Re-read and re-decide a
failed item; do not increment a stale image count.

For one cover, choose a clean exact manufacturer asset or exact retailer asset.
Reject lifestyle, bundle, watermarked, thumbnail, and unproven-variant images.
Keep catalog evidence with `source: catalog`, `sourcePageUrl`, `sourceAssetUrl`,
and `sourceName`; retain own photos as `source: own`, and use `unknown` only
when the provenance is unavailable. On Product attachments, set `purpose` to
`item` or `label`. Attach once with a fresh product read, `expectedImageCount`,
and a deterministic per-product key. Explicitly select the verified exact-product
catalog overview as the cover only when the Product has no own item image;
otherwise append the catalog image after the own item image (see
[product identity](references/product-identity.md) on belongings cover order)
and preserve our photos and labels. Later
manual order remains authoritative until another explicit replacement. Schedule
original analysis and useful item cutouts through `schedule_image_processing`;
skip label cutouts and already-transparent assets, preserve pairs, and let
pending/failed processing fall back to the original. Verify every mutation, including retained
identity facts, gallery order, cover, display position, integrity metadata, and
exact variant.

## Report

Return one compact row per candidate with identity, source link, changed fields,
image result, and one of `enriched`, `skipped — ambiguous`, `skipped — no exact
source`, `skipped — retired/bundle-only/no canonical image`, or `failed —
<reason>`. State unresolved identity, price, or nutrition gaps separately.
