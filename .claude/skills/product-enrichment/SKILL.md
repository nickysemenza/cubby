---
name: product-enrichment
description: Enrich Cubby Products with verified identity facts and representative cover images. Use for missing product metadata/images, specific Products from purchase import, or source-backed corrections.
---

# Enrich Cubby products

Research exact Product identity and representative images from retained sources.
Interactive Claude/Codex research and automatic Cubby Runs share these domain
contracts. For a hosted Run, use the [research workflow](references/research-run-workflow.md)
and its mounted tools. In an interactive session, use the available research and
bounded Cubby write tools; verify what their results persisted before reporting
success. A populated field or source link alone does not establish retained
verification.

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
variants. Preserve ambiguity as unresolved work with its competing candidates.

A hosted Run retains observations against its explicit task. Connect the ordered
item to the observed selected variant, then support each fact and image with its
issued evidence reference. Structured Product data is useful evidence; retained
visible content and selected-variant state can also establish facts when JSON-LD
is missing or describes a group. A quotation establishes what was observed, not
which purchased variant it belongs to. Reject contradictions and preserve
identifier kinds and issuer ownership. An identifier another Product owns
requires review, never reassignment.

Imported Products acquire automatic research work. Public-page research can
continue without a Mac; authenticated browser work waits for the connected
browser. Matching existing values can gain provenance without changing the
value. Supported contradictions appear in the Run's generic findings report
with saved and proposed values and retained support. Review and explicitly
approve the atomic proposal there; approval rechecks its accepted assessment,
admission, identity, source bytes and current Product before writing. A stale
proposal refuses without replacing member edits. Automatic research promotes a
verified image only over an explicitly marked provisional import thumbnail,
preserving own photos, member-selected gallery order and unknown historical
cover intent. Reselecting the same gallery order still records member intent;
`source: catalog` alone never authorizes promotion.
A resolved attempt with gaps is not full verification; relevant
new evidence or changed instructions can make those gaps eligible again, while
unchanged failures pause rather than loop.
To start one yourself, read `imports_read.run_launch_preview` for the Product's
`sourceId`, then call `run.start` with purpose `product_enrichment`; a
`blockingRun` answer reports the launch constraint. Read
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

Return one compact row per candidate with identity, retained sources, changed
and verified matching fields, image result, and the explicit outcome: verified,
partially verified, researched with gaps, ambiguous, temporarily blocked, or no
source found. Distinguish execution finishing from the Product being verified.
State remaining identity and image gaps and any review proposal separately.
