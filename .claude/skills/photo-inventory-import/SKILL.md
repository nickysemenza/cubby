---
name: photo-inventory-import
description: Import household belongings or wardrobe photos into Cubby from a photo_inventory ImportRun, preserving evidence, ownership, locations, and duplicate decisions.
---

# Photo inventory import

A member uploads photos from the native app into a `photo_inventory`
`ImportRun` (`RUN-…`): `ledgerPartyId` names whose belongings the batch is,
and free-text `notes` gives context such as a location by time window (e.g.
"9:15–9:40am: primary closet"). Work exactly one run per invocation.

## Read the run

`entity get importRun { id }` for `ledgerPartyId` and `notes`. Then
`entity list image { filters: { importRunId, targetState: ["pending"] } }` —
the list is already ordered by the run's picker `position`, which reflects
capture order. Each image carries `importTarget` (`state`, `position`) and
`analysisSummary` (`description`, `classifications`, `recognizedText` —
on-device Vision plus the cloud description, when either has run). Read
`analysisSummary` and `position` adjacency first; open an image (`representations`)
only when the summary leaves the item, its label text, or a group boundary
genuinely unclear — most groups resolve from the summary alone.

## Group and identify

Group adjacent-position images into one physical item using position order,
OCR text, and description together — a run of positions with consistent OCR
(a size tag, a care label) or matching description is one item; a jump in
subject is a new item. Distinguish `dupefile` (the same shot again),
`additionalview` (another angle of the same physical thing), and
`physicalcopy` (a distinct owned instance) — only `physicalcopy` changes
inventory quantity; `dupefile` and `additionalview` attach as extra `item`
images on the same group, never as a second Product or a quantity increase.
Flag an unsupported video as a skip; never treat it as imported.

Name and match per [product identity](../product-enrichment/references/product-identity.md):
`Brand Model — Color, Size`, one Product per exact variant. Before creating,
check for an existing match — `resolve_products` for name/alias hits,
`find_similar_entities` for a visual/embedding candidate, and
`entity list product { filters: { dataGap: "product_unpurchased" } }` scoped
to this owner/category for a Product a prior photo batch already created but
never received inventory for. Also check existing purchase-created Products
in the same category lacking inventory — a receipt-only Product this batch's
photo now stocks. Never create a Product merely because the match was
inconclusive; when uncertain, prefer `existingId` and let a human correct it
later over minting a near-duplicate.

For apparel specifically, load
[the Apparel taxonomy](references/apparel.md) before naming or classifying —
it lists the current root/group/type choices and the tag-transcription rules.

## Commit the group

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
