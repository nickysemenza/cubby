---
name: photo-inventory-import
description: Import household belongings or wardrobe photos into Cubby from a photo_inventory ImportRun, preserving evidence, ownership, locations, and duplicate decisions.
---

# Photo inventory import

A household member uploads photos through the Cubby iOS/macOS app (the
`PhotoImportRunUploader` path) into a `photo_inventory` `ImportRun`
(`RUN-…`) — agents read the run and propose groups for human approval.
`ledgerPartyId` names the one member whose belongings the run is; a run never
mixes household members' items, so every group's owner defaults to that same
party. Free-text `notes` gives context such as a location by time window
(e.g. "9:15–9:40am: primary closet"). Work exactly one run per invocation.

## Read the run

`entity get importRun { id }` for `ledgerPartyId` and `notes`. Then
`entity list image { filters: { importRunId, targetState: ["pending"] } }` —
the list is already ordered by the run's picker `position`, which reflects
capture order. Each image carries `importTarget` (`state`, `position`) and
`analysisSummary` (`description`, `classifications`, `recognizedText` —
on-device Vision plus the cloud description, when either has run). Read
`analysisSummary` and `position` adjacency first; open an image (`representations`)
only when the summary leaves the item, its label text, or a group boundary
genuinely unclear — most groups resolve from the summary alone. Background
removal is queued for every image automatically; cutouts appear only while
image processing is enabled and a paired Apple device is connected, so a
missing cutout is not an import failure.

Record a legible barcode with `patch_product_external_ids` (`source: "gtin"`,
`kind: "gtin_14"`) so a later order line matches it exactly — see
[product identity](../product-enrichment/references/product-identity.md).

## Group and identify

Group adjacent-position images into one physical item using position order,
OCR text, and description together — a run of positions with consistent OCR
(a size tag, a care label) or matching description is one item; a jump in
subject is a new item. Every close-up of a size tag, care label, box, or
other identifying label is `purpose: "label"`, never `item`. Distinguish
`dupefile` (the same shot again), `additionalview` (another angle of the same
physical thing), and `physicalcopy` (a distinct owned instance) — only
`physicalcopy` changes inventory quantity; `dupefile` and `additionalview`
attach as extra `item` images on the same group, never as a second Product or
a quantity increase. Videos are unsupported: flag them as a skip; never treat
one as imported.

Name and match per [product identity](../product-enrichment/references/product-identity.md)
— its either-side-first contract governs every photo Product: `Brand Model —
Color, Size`, one Product per exact variant. Before creating, check for an
existing match — `resolve_products` for name/alias hits, `find_similar_entities`
for a visual/embedding candidate, and `entity list product { filters: {
dataGap: "product_unpurchased" } }` scoped to this owner/category for a
Product a prior photo batch or a purchase already created but never received
inventory for. An exact identifier read off a label or box (SKU/UPC/model)
that matches a candidate supports `existingId`. A strong combination of
visible brand, garment features, color, and variant evidence may also support
proposing that existing Product for human approval; explain any unreadable size
or color in the proposal evidence so the reviewer can switch Products. If
multiple exact variants remain plausible, ask the reviewer to resolve that
uncertainty before approval. Create a Product only after the existing catalog
has been checked and no candidate fits the physical item. The
recommendations workbench is for reconciling Products already created; it is
not the purchase-linking step.

For apparel specifically, load
[the Apparel taxonomy](references/apparel.md) before naming or classifying —
it lists the current root/group/type choices and the tag-transcription rules.

## Propose the groups

Send groups with `propose_photo_groups` `{ runId, groups }` — the same group
shape `commit_photo_group` takes, minus `runId`, plus optional `evidence`
(why these photos are one item and why this Product). Nothing is written to
Products or Inventory yet: the user reviews, edits and approves each group on
the run page, and approval runs `commit_photo_group` with that payload. Call
`commit_photo_group` directly only when the user explicitly asks to skip
review.

Each group: `product` is `{ kind: "existing", existingId }` or
`{ kind: "create", create: {...} }`; `images` lists every attached image with
`purpose: "item"` or `"label"`; `skip` lists every rejected image (duplicate
file, unusable frame, video) with a reason — every image must appear in
exactly one of `images` or `skip`, across all proposed groups of the run. Add
`inventory` once ownership and location are settled: `ownershipMode:
"person"` with the owner (default the run's own `ledgerPartyId` unless the
photo says otherwise) and a real location — resolve one from the run's
`notes` (location-by-time-window) or ask; never invent a holding location.
Omit `inventory` when ownership or location is genuinely unresolved and say
so in `evidence` — a group is not forced into a guess to stay unblocked.

Use a stable `groupKey` per physical item. Re-proposing a groupKey replaces
it while it is still `proposed`; `committed`/`discarded` groups are frozen and
come back in `frozenGroupKeys`; `removeGroupKeys` drops a proposed group.
Then stop and tell the user the groups are ready to review on the run page.
Read the outcome with `list_photo_group_proposals`: a group left `proposed`
with `conflict` hit an exact case-insensitive name/alias collision (re-propose
with that `existingId` or a distinctly different name); `lastError` is a
failed approval to fix and re-propose.

Set the Product's `imageOrder` (own item cutout first, verified catalog image
second, labels last) only when a catalog image is added after the own photo
already exists — see the cover-order note in
[product identity](../product-enrichment/references/product-identity.md). A
group with only its own photos needs no reordering.

## Finish

The run is done once `entity list image { filters: { importRunId,
targetState: ["pending"] } }` returns nothing — the approval (or discard)
that settles the last pending image marks the run `completed` automatically. Report items
committed, images skipped (with reasons), Products matched vs. created,
inventory received, and every open question (ambiguous ownership, unresolved
location, an unresolved `conflict`). Then check
`dataGap: product_unpurchased` — a photo-created Product left there is a
handoff to purchase-import, not a task this run repeats.

Do only the requested import: never infer prices, receipts, purchases,
vendors, or purchase relationships from a photo. A later receipt is handled
by `purchase-import`, which matches this same Product (see `dataGap:
product_unpurchased`) using settlement evidence only and creates no new
inventory.
