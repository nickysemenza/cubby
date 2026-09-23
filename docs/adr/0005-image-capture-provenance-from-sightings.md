# ADR 0005: Image capture provenance derived from sightings, not stored per device

Status: Proposed

## Context

`Image.source` is set reliably only on URL-driven catalog imports;
`attach_files` drops the URL it was given, and native uploads never mark
`own`. Capture date, GPS, and camera are largely gone: the legacy iOS uploader
re-encoded originals to `photo.jpeg`, and web/Messages/AirDrop paths strip
EXIF on the way in. Where a photo came from, and who took it, is mostly
`unknown` today.

Attribution is also structurally one level too coarse. Photo Library sync
puts the same asset on a member's phone and their Mac — that is one photo,
reported twice, by one person. A photo one member texts another and both
save is one photo, reported by two people. A single `capturedByDeviceId`-style
column on Image cannot represent either case without either losing the second
report or forcing Image itself into a one-to-many shape it otherwise doesn't
need.

## Decision

Image stays one row per stored pixel set. A new many-row `ImageSighting`
(`IMS-`) entity records each report of an image in a member's photo library
or cloud asset store — `(imageId, ledgerPartyId, assetKey)` unique, so a
repeat report from the same person's second device replaces the observation
columns on the existing row instead of duplicating it. A pure function,
`deriveImageCapture`, reduces an image's live sightings (and, failing those,
embedded EXIF) to the _derived_ fields stored directly on Image:
`capturedAt`, `capturedAtOffsetMinutes`, `captureLocation`, `capturePlaceName`,
`captureDeviceLabel`, `capturedByPartyId`, and a `captureAttribution` of
`none | derived | ambiguous | confirmed`.

The reduction rule, in order:

1. A `confirmed` attribution is sticky — a member's manual correction is
   never recomputed away.
2. A screenshot subtype on any sighting sets `source=screenshot` and clears
   capture attribution: a screenshot has no photographer, camera, or GPS.
3. "Strong" sightings — an import commit's own report, or a library-scan
   match close enough on perceptual hash (distance ≤ 2, or 3–6 with an aspect
   gate), always from a genuine on-device library (`sourceType=userLibrary`,
   never cloud-shared or iTunes-synced) — are grouped by reporting party. One
   party's group derives the capturer outright. Several parties' groups are
   scored (+3 a location, +2 a camera, +1 a HEIC/RAW filename, +1 the
   earliest capture, +1 the earliest library add); a unique maximum derives,
   a tie is `ambiguous` with no capturer until a member confirms one. A
   strong sighting also sets `source=own` — a member's own Photos library
   holding the pixels is the "camera roll means ours" rule, and it is how a
   legacy re-encoded upload regains its provenance from a later library scan.
4. No strong sightings but usable EXIF: capture fields come from EXIF, with
   no capturer — EXIF proves when and where, never who.
5. Neither: nothing new to derive. Evidence this function itself produced
   (a `sighting` basis) is retracted if its last supporting sighting is gone,
   rather than left stale; evidence from anything else — a manual edit, an
   import URL, EXIF, or future provenance analysis — is left untouched.

Every `ImageSighting` create, update, and delete re-runs this derivation for
its image in the same transaction, so an image's derived fields are never
stale relative to its own sightings for longer than that one write.

`Device` (`DEV-`) is the reporting party for a sighting's `deviceId` and is
itself a manifest entity (ADR-adjacent, delivered alongside): one row per
native install, optionally owned by a Ledger Party member. `ImageSighting`'s
owner resolves from the acting login through the member-login mapping when
not given explicitly; unlike Device ownership, an unlinked login is refused
rather than silently accepted, because there is no such thing as an unowned
photo-library report.

Both `Device` and `ImageSighting` are declared as ordinary manifest entities
— generated columns, schemas, OpenAPI, Swift types, routes, editor, MCP
`entity` tool, filters, edges — rather than one-off tables. Hand-written code
is limited to the derivation function itself, the sighting adapter's upsert,
the photo-import commit's per-item `library` block, and (later PRs) EXIF
parsing and filename heuristics.

## Consequences

- New edges: `ImageSighting → Image` (cascade on delete), `ImageSighting →
LedgerParty` (block delete, repoint on merge), `ImageSighting → Device`
  (cascade on delete), `Image.capturedByPartyId → LedgerParty` (clear owner
  on delete, repoint on merge).
- `Image.source` gains `screenshot`; every hand-typed union mirroring it
  (transform/vendor mappers, the pending-upload UI state) needed updating
  alongside the generated one.
- `attach_files` previously dropped a caller-supplied `source`/`url` on the
  floor; it now defaults `source` to `catalog` when a URL drove the
  attachment and records `provenanceEvidence: {basis: "import-url"}`,
  participating in the same precedence order derivation respects.
- CONTEXT.md gains _Image Sighting_, _Capture Attribution_, and _Device_, and
  extends _Ledger Party_ to name it as the identity behind both.
- Not decided here: EXIF extraction itself (a server background task, PR6),
  `imageList` moving onto the generic `listScaffold` (PR3b, which is also
  what lets Image's manifest filters and data quality bind generically), and
  provenance-analysis heuristics (`classifyImageProvenance`, PR3b).

See [docs/plans/image-provenance-and-devices.md](../plans/image-provenance-and-devices.md)
for the full model, delivery sequence, and native participation-switch work
this ADR's PR (3a) shares a plan document with but does not itself decide.
