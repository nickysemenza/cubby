---
name: photo-inventory-import
description: Import household belongings or wardrobe photos into Cubby from a photo_inventory ImportRun, preserving evidence, ownership, locations, and duplicate decisions.
---

# Photo inventory import

A household member uploads photos through the Cubby iOS/macOS app (the
`PhotoImportRunUploader` path) into a `photo_inventory` `ImportRun`
(`RUN-…`) — agents never upload bytes, only read and commit an existing run.
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
that matches one of those candidates claims it directly (`existingId`). A
same-category candidate with no identifier to confirm it is not enough to
claim: create the photo's own Product and call `propose_product_match` so a
human can confirm the pair in the recommendations workbench. Never create a
Product merely because a match looks plausible without identifier proof, and
never claim a descriptive-only candidate directly.

For apparel specifically, load
[the Apparel taxonomy](references/apparel.md) before naming or classifying —
it lists the current root/group/type choices and the tag-transcription rules.

## Commit the group

A web review step for proposed groups (`propose_photo_groups` plus human
approval) is planned but not yet built. Until it lands, present the full
grouping manifest — each group's photos (item vs. label), its proposed
Product (new or existing, with match evidence), and its location — to the
user and get approval before calling `commit_photo_group`.

Write each group with `commit_photo_group`: `product` is
`{ kind: "existing", existingId }` or `{ kind: "create", create: {...} }`;
`images` lists every attached image with `purpose: "item"` or `"label"`;
`skip` lists every rejected image (duplicate file, unusable frame, video)
with a reason — every image in the group must appear in exactly one of
`images` or `skip`. Add `inventory` once ownership and location are settled:
`ownershipMode: "person"` with the owner (default the run's own
`ledgerPartyId` unless the photo says otherwise) and a real location — resolve
one from the run's `notes` (location-by-time-window) or ask; never invent a
holding location. Omit `inventory` and ask, or leave the group `skip`-only,
when ownership or location is genuinely unresolved — a group is not forced
into a guess to stay unblocked.

`commit_photo_group` is idempotent per `(runId, groupKey)`: after a lost
response, retry the identical call (same `groupKey`, same payload) rather
than re-sending a changed one — it replays the prior result instead of
writing again. Use a stable `groupKey` per physical item so a retry is
recognizable; never reuse a `groupKey` for a different group. A `conflict`
outcome means an exact case-insensitive name/alias collision: read the
returned colliding Product ids, then resend with that `existingId` or a
distinctly different name — never resend the identical `create` expecting a
different result.

Set the Product's `imageOrder` (own item cutout first, verified catalog image
second, labels last) only when a catalog image is added after the own photo
already exists — see the cover-order note in
[product identity](../product-enrichment/references/product-identity.md). A
group with only its own photos needs no reordering.

## Finish

The run is done once `entity list image { filters: { importRunId,
targetState: ["pending"] } }` returns nothing — `commit_photo_group` marks the
run `completed` on the same transition automatically. Report items
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
