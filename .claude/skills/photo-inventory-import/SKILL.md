---
name: photo-inventory-import
description: Import household belongings or wardrobe photos into Cubby from a photo_inventory Run, preserving evidence, ownership, locations, and duplicate decisions.
---

# Photo inventory import

For a durable `photo_inventory` Run continuation, load
[run-workflow.md](references/run-workflow.md). It gives the ordered MCP steps,
review stop, and run identity used by the import-run agent, Codex, and Claude.

A household member uploads photos through the Cubby iOS/macOS app (the
`PhotoImportRunUploader` path) into a `photo_inventory` `Run`
(`RUN-…`) — agents read the run and propose groups for human approval.
`ledgerPartyId` names the one member whose belongings the run is; a run never
mixes household members' items, so every group's owner defaults to that same
party. Free-text `notes` gives context such as a location by time window
(e.g. "9:15–9:40am: primary closet"). Work exactly one run per invocation.

## Read the run

Call `imports_read.photo_context { runId }` for `ledgerPartyId`, `notes`, and the
run's photos, one page at a time: pass `nextCursor` back as `cursor` until it
is null. Filter its images to `targetState: "pending"`; the pages are in
capture order (`capturedAt`, undated photos last), even across batches
appended to the same run. Each image carries `targetState`, `capturedAt` with
its `capturedAtOffsetMinutes`, `position` (picker order within one upload),
`description`, and `recognizedText` (on-device Vision OCR plus the cloud
description, when either has run). Read those summaries and capture-order
adjacency first; match `capturedAt`, read as local time through its offset,
against time windows in the run's `notes` to place each item. If you can view images, pass
`withImageUrls: true` and open the image bytes directly (`originalUrl` or `cutoutUrl`) when the host
supports image viewing, or use the browser image viewer only
when the summary leaves the item, its label text, or a group boundary
unclear — most groups resolve from the summary alone. Browser screenshots
are a fallback for visual questions, not a required step per photo. Read OCR
and descriptions as leads; the actual label takes precedence when they conflict. Background
removal is queued for every image automatically; cutouts appear only while
image processing is enabled and a paired Apple device is connected, so a
missing cutout is not an import failure.

Record a legible barcode with an `entity.update product` `externalIds` add patch
(`source: "gtin"`, `kind: "gtin_14"`) so a later order line matches it exactly — see
[product identity](../product-enrichment/references/product-identity.md).

## Group and identify

Group adjacent images into one physical item using capture order, OCR text,
and description together — a run of photos with consistent OCR
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
existing match — call `imports_read.photo_candidates` once per distinct
item with its observed name and manufacturer. Its results include purchase,
own-photo, earlier photo-import, and inventory evidence. Compare exact variant
facts yourself; rank and absence of an own photo are useful leads, not proof.
Use `entity_read.resolve` or `search.similar` only
when the candidate response leaves a concrete identity question unanswered;
avoid repeating broad catalog reads for every photo of the same item. A
purchase-created Product without an own photo deserves close inspection even
when it came from a vendor import. An exact-variant identifier read off a label or box (UPC or a
per-variant SKU) that matches a candidate supports `existingId`; a style or
model number shared across sizes or colors only ranks candidates. A strong combination of
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

Send groups with `photo_run.propose_groups` `{ runId, groups }` — the same group
shape `photo_run.commit_group` takes, minus `runId`, plus optional `evidence`
(why these photos are one item and why this Product). Nothing is written to
Products or Inventory yet: the user reviews and edits groups on the run page,
then approves one or a selected batch. Approval runs `photo_run.commit_group` for
each selected group with its reviewed payload. Call
`photo_run.commit_group` directly, or approve with `photo_run.approve_groups`,
only when the user explicitly asks to skip or finish review.

Each group: `product` is `{ kind: "existing", existingId }` or
`{ kind: "create", create: {...} }`; `images` lists every attached image with
`purpose: "item"` or `"label"`; `skip` lists every rejected image (duplicate
file, unusable frame, video) with a reason — every image must appear in
exactly one of `images` or `skip`, across all proposed groups of the run.
Include `review` with the independent `observedName`, `unresolvedReason` (null
when resolved), and `stockIntent`: `evidence`, `counted`, `historical`, or
`receive`. An unresolved variant has an explicit reason; prose uncertainty
alone does not block approval. Choosing a catalog Product must not replace the
observed identity. Unknown brand/model alone need not block a distinct new item.

Only `receive` includes `inventory`: a whole-number quantity, real location,
and ownership. Omit both ownership fields to use the Run member, or pass
`ownershipMode: "explicit"` and `ownerPartyId` (null means household stock).
Never use the retired `person` value. Resolve the location from the Run's notes
or ask; never invent a holding location. Historical or sold items and stock
already counted attach evidence without receiving anything; historical intent
does not record a sale. If receiving is intended but ownership/location is
unresolved, keep an explicit `unresolvedReason` and ask before approval.

Attaching to an existing Product preserves its fields, existing gallery order,
and cover. Only explicit `review.productChanges` updates the selected name,
category, manufacturer, model, notes, or tags, atomically with attachments and
Inventory. Leave it absent unless the user chose those changes.

Use a stable `groupKey` per physical item. Re-proposing a groupKey replaces
it while it is still `proposed`; `committed`/`discarded` groups are frozen and
come back in `frozenGroupKeys`; `removeGroupKeys` drops a proposed group.
Then stop and tell the user the groups are ready to review on the run page.
Read the outcome with `imports_read.photo_proposals`: a group left `proposed`
with `conflict` hit an exact case-insensitive name/alias collision (re-propose
with that `existingId` or a distinctly different name); `lastError` is a
failed approval to fix and re-propose.

Set the Product's `imageOrder` (own item cutout first, verified catalog image
second, labels last) only when a catalog image is added after the own photo
already exists — see the cover-order note in
[product identity](../product-enrichment/references/product-identity.md). A
group with only its own photos needs no reordering.

## Finish

The run is done once `imports_read.photo_context` has no pending images — the
approval (or discard) that settles the last pending image marks the run
`completed` automatically. Report items
committed, images skipped (with reasons), Products matched vs. created,
inventory received, and every open question (ambiguous ownership, unresolved
location, an unresolved `conflict`). Then check
`dataGap: product_unpurchased` — a photo-created Product left there is a
handoff to purchase-import, not a task this run repeats.

Do only the requested import: never infer prices, receipts, purchases,
vendors, or purchase relationships from a photo. A later receipt is handled
by `purchase-import`, which compares evidence before creating and matches the
same Product (see `dataGap: product_unpurchased`) using itemized order and
exact-variant evidence; it
handles settlement separately and creates no new inventory.

## Joining later evidence

Treat this run as the photo side of the [product identity
journey](../../../docs/guide/product-identity-journey.md). An agent may later find an
itemized retailer order through connected Gmail or a retailer account, and a
posted charge through a statement import. Only the order line can establish a
Purchase-to-Product relationship; the statement can settle that Purchase but
cannot identify the garment. Propose uncertain Product matches for human
review, with label, color, size, and source-image provenance visible. Never
attach a charge to a Product directly.

Candidate purchase lines and eligible unlinked Expenses expose
`acceptedSourceLines` selectors containing `sourceOrderId` and `lineIndex`.
Use only a known selector owned by the authenticated member; an empty array
means the historical accepted extraction is unknown and cannot authorize a
link. Prepare the shared source-order reconciliation with that `sourceOrderId`
and an `attach_only` resolution naming the existing Expense and approved
Product. Review the resulting ledger preview, then commit the accepted-source
review. This changes the existing line's Product attribution without creating
an Expense or receiving Inventory, and replay preserves that result. Follow
the [purchase-import skill](../purchase-import/SKILL.md) for the review workflow.
