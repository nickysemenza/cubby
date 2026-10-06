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
Enrichment never invents a price or date; a historical acquisition of unknown cost is an Expense with `cost: null` and no `date`.
For a backlog, `entity_read.list product` with `sort=dataQuality` ascending puts the
weakest identity first (heavier identity checks — manufacturer, external ID —
outweigh lighter ones), in pages of 25. Narrow to a specific gap with
`filters.dataGap` on a check id: `product_manufacturer`, `product_external_id`,
`product_category`, `product_model`, `product_price`, `product_image`,
`amazon_asin`. Start with summary/count reads, then
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

A targeted run's commit trusts only retained browser evidence of the exact
variant. Besides an Amazon ASIN, the server proves a retailer SKU, item or
catalog number, or GTIN from any run-vendor page that exposes exactly one
schema.org Product (never a ProductGroup or several variants) whose matching
field equals the identifier. Search results, aggregators, and free-text hints
are leads, not proof; an identifier the page does not show is refused. A proven
identifier another Product owns is skipped, reported in `skippedIdentifiers`, and
proposed in the match queue, never reassigned. A target with no exact source is
closed with `product_enrichment.skip` and its reason, never left open: the run
moves to its next Product, and a committed or skipped Product is not swept again.

Imported Products enrich without a click: after an import commits, on every
discovery pass, and when an account turns browser sync on, the server starts one
targeted run per browsing account whose Mac is connected, for Products an import
created that no run has committed or skipped (at most three attempts each).
To start one yourself, read `imports_read.run_launch_preview` for the Product's
`sourceId`, then call `run.start` with purpose `product_enrichment`; a
`blockingRun` answer means the account is busy and nothing was queued. Poll
`entity_read.get` on the RUN- id with `resultDetail: "full"` for its status.

Read [source mechanics](references/sources.md) only for the source in hand.
Read [write and image rules](references/writes-and-images.md) when preparing a
write, collision, batch, kit, replacement, or verification.

## Write safely

Before enriching, check whether this Product has a merge candidate on the
other side (a photo Product for a purchase-created one, or vice versa) per
[product identity](references/product-identity.md)'s either-side-first
contract; propose it with `product_enrichment.propose_match` rather than enriching two
records that should converge into one.

Set `kind` (`consumable` or `durable`) only when the published product or the
order context makes it clear; never guess, and leave it unset when uncertain. It
only informs project suggestions and is independent of `stockTracked`.

Use `product_enrichment.patch_external_ids` for exact slot changes and preserve unrelated
IDs; use a full `entity.update product` external-ID set only when deliberately
replacing it. Check `imports_read.external_id_collisions` before each new ID. Only an
exact-variant part number goes in as `manufacturer_part` (source = manufacturer
slug); a family/style number stays in `model`.
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
original analysis and useful item cutouts through `image.schedule_processing`;
skip label cutouts and already-transparent assets, preserve pairs, and let
pending/failed processing fall back to the original. Verify every mutation, including retained
identity facts, gallery order, cover, display position, integrity metadata, and
exact variant.

## Report

Return one compact row per candidate with identity, source link, changed fields,
image result, and one of `enriched`, `skipped — ambiguous`, `skipped — no exact
source`, `skipped — retired/bundle-only/no canonical image`, or `failed —
<reason>`. State unresolved identity, price, or nutrition gaps separately.
