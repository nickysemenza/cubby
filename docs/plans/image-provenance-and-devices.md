# Image provenance, device participation, and background-activity visibility

Status: **approved, in delivery** (2026-09-21). PR order and lane ownership are
at the end; each PR removes its own line here when it merges.

## Outcome

Cubby knows where every image came from, which household member captured it,
and which native install is doing automatic work — and an install can opt out
of all of it and remain a plain viewer.

Three problems share one root today:

1. **An install participates silently.** On every sign-in the native app opens
   the companion websocket and advertises itself for server-pushed subject-lift
   and image-description jobs; on macOS it connects unconditionally in the
   background. Opening the Photos tab starts a library hash scan, a
   classification sweep, and a repair pass that downloads full-resolution
   originals. There is no "viewer only" setting.
2. **Image origin is mostly `unknown`.** `Image.source` is auto-set only on URL
   imports; `attach_files` drops the URL it was given; native uploads never
   mark `own`. Originals are stored unmodified, but the legacy iOS uploader
   re-encoded to `photo.jpeg`, and web/Messages/AirDrop paths lose EXIF, so
   capture date, GPS, and camera are gone for most rows.
3. **Attribution is per device, never per person, and never many.** Photo
   Library sync puts one asset on a member's phone and Mac; a photo one member
   texts another lands in both libraries. A single-owner column is wrong on
   day one.

## Decisions

- **Sightings, not arrays.** Image stays one row per stored pixel set. A new
  many-row `ImageSighting` entity records each (image, member library, cloud
  asset) and *derived* declared-`one` fields on Image summarise it — ADR
  0001's Purchase-products shape (one logical relation, many provenance
  sources). A schema-wide "array + runtime clamp" construct is deferred (see
  todos).
- **Capturer is a Ledger Party member**, resolved from the session login via
  the member-login mapping; a guest's photo can be attributed to a guest
  party. CONTEXT.md gains *Image Sighting*, *Capture Attribution*, *Device*.
- **One master participation switch per install, mirrored to a `Device`
  entity** the job dispatcher honours; explicit manual uploads always work.
- **Generic first.** `Device` (`DEV-`) and `ImageSighting` (`IMS-`) are
  manifest entities: generated columns, schemas, OpenAPI, Swift types,
  list/detail routes, generic editor, MCP `entity` tool, data quality,
  filters, relation graph. Hand-written code is limited to transport
  enforcement in the companion durable object, the photo-import commit's
  per-item `library` block, the sighting adapter's upsert + derivation hook,
  EXIF parsing, and filename heuristics.
- **Device-local work is visible in native Activity** ("This device" section)
  and a persistent iOS `.tabViewBottomAccessory` bar; only companion jobs
  deep-link to server runs. The local activity shape mirrors `ActivityRun` so
  a later Workflows pass can post it server-side.

## Model

```
Image (IMG-)                      ★ = new, all nullable/additive
  source: own | catalog | unknown | ★screenshot
  ★ capturedAt, ★ capturedAtOffsetMinutes, ★ captureLocation {lat,lng,…} (detail only)
  ★ capturePlaceName, ★ captureDeviceLabel
  ★ capturedByPartyId → LedgerParty   (relation captured-by, derived)
  ★ captureAttribution: none | derived | ambiguous | confirmed
  ★ provenanceEvidence {basis: manual|sighting|import-url|exif|analysis|filename, ruleId?}
  ★ metadataRevision                  (EXIF task stale marker)

★ ImageSighting (IMS-)  one row per (image, member library, cloud asset)
  imageId → Image, ledgerPartyId → LedgerParty, deviceId → Device
  assetKey = cloudIdentifier ?? "local:<installationId>:<localIdentifier>"   UNIQUE with imageId+ledgerPartyId
  sourceType, mediaSubtypes[], originalFilename, pixelWidth/Height, hasAdjustments
  capturedAt, capturedAtOffsetMinutes, addedAt, location, placeName, camera {make,model,lens,software}
  matchKind: import | libraryMatch, hashDistance, aspectGate, observedAt

★ Device (DEV-)  one install of the native app
  installationId UNIQUE, name, platform ios|macos, appVersion, osVersion, lastSeenAt
  automaticWork (device-set), remotePaused (web-set)
  ledgerPartyId → LedgerParty (owner), productId → Product (the physical phone)
```

Derivation (`services/image-capture-derivation.ts`, pure, run in the writing
transaction): `confirmed` is never overwritten; a screenshot subtype sets
`source=screenshot`; strong sightings (import, or hash distance ≤ 2, or 3–6
with the aspect gate, `sourceType=userLibrary`) group by party; one party →
`derived`; several → score each party's best sighting (+3 location, +2
camera, +1 HEIC/RAW filename, +1 earliest capture, +1 earliest added), unique
maximum → `derived`, tie → `ambiguous`; no sightings but EXIF → capture fields
from EXIF with no capturer. Precedence: manual > sighting > import-url > exif >
analysis > filename.

Worked example (synthetic members Ana and Ben): Ana's phone and Mac both
report her photo → one sighting, `capturedBy=Ana`. Ben texts Ana a photo he
took and she saves it → two sightings; Ben's carries GPS and camera and wins.
Both save the same AirDropped photo from a guest → tie, `ambiguous`, until a
member sets the guest party (`confirmed`). A legacy `photo.jpeg` upload later
matched by a library scan regains its capture date and GPS and flips
`unknown → own`.

## Compatibility constraints found in review

- The OpenAPI emitter closed every output object (`additionalProperties:
  false`), so the generated Swift client rejected any response with a new
  field. Outputs are now emitted open (PR0); a build with that client must be
  installed on every household device before a server deploy adds output
  fields.
- A companion hello without `participation` is a legacy client and is treated
  as participating; the `helloAck` message is sent only to clients that sent
  `participation`, because the native receive loop decodes a closed union.
- New FK edges (`ImageSighting→Image/LedgerParty/Device`,
  `Image.capturedByPartyId→LedgerParty`, `Device→LedgerParty/Product`) are
  declared in `entity-edges.ts` with a disposition per lifecycle policy;
  LedgerParty merge repoints both party columns.
- Photo-import commit compares `analysis` by JSON equality across items that
  resolve to one image, so per-asset library data is an item-level sibling.
- `imageList` is not on `listScaffold`; moving it there is what lets manifest
  filters and data quality bind generically.

## Delivery

| PR | Scope | Status |
| --- | --- | --- |
| 0 | Generator emits open output schemas; regenerated `CubbyAPI`; response-body guard test | in PR |
| 1 | `Device` entity, companion enforcement + legacy-hello compatibility, connections link | next |
| 2 | Native participation switch, first-sign-in sheet, gate matrix, REST identity headers, generic Device create/update | |
| 3a | `ImageSighting` entity, Image derived fields, derivation + adapter hook, commit `library` items, `attach_files` source fix, `screenshot`, edges, runbook, glossary, ADR | |
| 3b | `imageList` onto `listScaffold`, Image data quality, provenance heuristics + `classifyImageProvenance`, location field renderer | |
| 4 | Native activity center, iOS bottom accessory, macOS sidebar rows, Activity "This device", `Route.localActivity`, `CubbyLink.activity` | |
| 5 | Native library metadata on import, `LibraryMetadataSync` backfill via generic sighting create, provenance section | |
| 6 | Server EXIF extraction background task, `backfillImageMetadata` | |

Rollout: 0 (deploy + install everywhere) → 1 → 2 (TestFlight) → 3a/3b
(runbook expand → deploy → `classifyImageProvenance` dry-run → apply) → 4/5
(TestFlight) → 6 (deploy → backfill). All new inputs are optional so older
native payloads stay valid throughout.
