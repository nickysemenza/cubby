---
name: product-enrichment
description: Burn down Cubby's Research queue - enrich Products with verified identity facts, Sources and representative cover images using your own browser. Use for missing product metadata/images, specific Products from purchase import, or source-backed corrections.
---

# Enrich Cubby products

Research exact Product identity and representative images, then write them with
the Sources that support them. This is Burn-down (ADR 0010): your Claude or Codex
session owns the browser, the searching and the judgment; Cubby owns ownership,
identifier collisions, image integrity and safe writes. Nothing researches
Products unattended, so an absent session leaves the Research queue as it is.
Verify what each write persisted before reporting success; a populated field
alone does not establish verification.

## Worklist and read shape

Use supplied `PRD-` identifiers regardless of inventory. Enrichment never
decides whether an import line becomes a Product and never receives inventory.
Enrichment never invents a price or date; a historical acquisition of unknown cost is an Expense with `cost: null` and no `date`.
The Research queue is the `research-queue` saved view on Products (and on
Purchases and Expenses for import gaps). For a backlog, `entity_read.list product` with `sort=dataQuality` ascending puts the
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

For branded seed packets, `manufacturer` is the packet brand established by the
packet or exact product source. A credited seed grower stays in the Source quote;
it does not replace the packet brand, and a retailer's name alone does not
establish it. When the brand is unclear, keep the current value or leave it
blank and report the gap.

Start with the purchased item: the original order Email (`imports_read.mail`, by
the Gmail ids in the Purchase's Email history, or your own Gmail connector) and
its order-line links, then the member's authenticated order details/history in
your browser. Recover missing saved originals
through owned mail (`mail.search` retains each match as an `uncertain`
candidate; settle every one with `mail.resolve`) and account history before
assuming only a name is available.
Do not begin with generic name search when usable purchase sources exist. Use
broader search for unavailable sources or facts those sources cannot establish.

Prove the exact variant before writing: accepted purchased-item URL, existing external-ID URL, deterministic
UPC lookup, manufacturer page, then exact retailer page. An Amazon ASIN can use
`https://www.amazon.com/dp/<ASIN>`; confirm the selected variant. General search
and aggregators may find a primary page but cannot overwrite a populated fact.
Never generate an image with AI.

Record only published evidence: UPC/EAN/GTIN in `upc` with leading zeroes,
maker MPN in `model`, Amazon ASIN as `externalIds` `amazon`/`asin`, and retailer
SKUs in their typed slot. Use lowercase kebab-case source slugs. A source/kind/
external-ID tuple has one live owner; do not invent, relabel, or choose between
variants. Preserve ambiguity as unresolved work with its competing candidates.

Connect the ordered item to the observed selected variant, then record each fact
with a Source: `sources: [{fieldPath, url, quote, observedAt, selectedVariant}]`
on `entity.update` (and record-level `sources` on `image.attach_files`). Quote the
relevant text, not the page; screenshots and full HTML are optional. Structured
Product data is useful evidence; visible content and selected-variant state can
also establish facts when JSON-LD is missing or describes a group. A quotation
establishes what was observed, not which purchased variant it belongs to. Preserve
identifier kinds and issuer ownership. An identifier another Product owns
requires review, never reassignment.

Your writes are the member's: a supported value may replace an existing one, and
the earlier value's Sources stay visible as "earlier value". When a fact cannot
be established, set a `data_exception` on that gap (`reason: unavailable` with a
note naming what you checked) so the Product leaves the Research queue until new
evidence changes it; do not loop on unchanged failures. Promote a verified image
to cover only over a provisional import thumbnail, preserving own photos,
member-selected gallery order and unknown historical cover intent;
`source: catalog` alone never authorizes promotion.

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

Change identifier slots with `entity.update product` collection patches on
`externalIds` (`{op: "add"|"replace"|"remove", key, value?, expect?}`), which
preserve unrelated IDs; a full `externalIds` array is a deliberate complete
replacement. Check `imports_read.external_id_collisions` before each new ID. Only an
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
