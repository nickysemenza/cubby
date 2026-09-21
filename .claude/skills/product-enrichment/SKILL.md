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
For a backlog, list Products with inventory present and no image, sorted by
identity strength, in pages of 25. Start with summary/count reads, then request
the relevant page; request full records only for candidates being researched.

Read a candidate immediately before every write. `imageCount` is the
displayable-image count; skip a gallery that already has an image unless the
user asked to replace or expand it.

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
Attach once with a fresh product read, `expectedImageCount`, and a deterministic
per-product key. Verify every mutation, including retained identity facts,
gallery order, cover, display position, integrity metadata, and exact variant.

## Report

Return one compact row per candidate with identity, source link, changed fields,
image result, and one of `enriched`, `skipped — ambiguous`, `skipped — no exact
source`, `skipped — retired/bundle-only/no canonical image`, or `failed —
<reason>`. State unresolved identity, price, or nutrition gaps separately.
