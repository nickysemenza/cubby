# Photos library deduplication

The native app presents a Photos-library grid that marks assets already in
Cubby, can filter to unchecked or unmatched assets, and avoids silently
uploading the same photo twice. Matching covers every live `Image` regardless
of its attachment. PDFs share the table and are excluded by `contentType`.

## Why similarity, not metadata

Photos reach Cubby by paths that often preserve pixels while discarding origin
metadata. The previous iOS uploader re-encoded to a 2048px JPEG named `photo.jpeg`; a web
drag from Photos can transcode HEIC to JPEG; edits change bytes; Messages,
AirDrop, Slack, screenshots, and MCP attachments may arrive without EXIF. A
Photos cloud identifier exists only on the app path, original-byte SHA-256
breaks on transcoding, and `IMG_NNNN` filenames collide across devices and
years. Filename matches can refer to different photos. Perceptual similarity
is therefore the durable primary signal.

## Experiment findings

The experiment computed a 64-bit DCT pHash (32×32 grayscale, DCT-II, top-left
8×8, bits above the median) through CoreGraphics on both sides. It compared
`cdn-cgi` 256px thumbnails with local 256px Photos thumbnails fetched by a Mac
PhotoKit CLI. Distance is Hamming distance; the median threshold makes every
distance even. Private library counts and source records are omitted here.

- Distances 0–2 separated matches well. Renames, HEIC-to-JPEG conversion,
  downscaling, and EXIF removal remained at distance 0; portrait rotation
  also agreed across both sides.
- Distances 4–6 mixed true and false matches. An aspect-ratio gate rejected
  square catalog images falsely matched to 4:3 photos.
- Distances 8–10 produced false matches: low-texture library images acted as
  attractors for scraped product-on-white images without matching aspect ratios.
- The 4–6 band needs further measurement on representative, consented photo
  samples before relaxing the strict threshold.
- In-app `CameraPicker` captures may never enter Photos. Pixel dimensions
  describe export paths but do not reliably identify phone photos.
- Bursts, retakes, and duplicates can put another library asset within distance 6. Treating a burst twin as probably in Cubby is the desired behavior.
- Hashing the same bytes with Sharp and CoreGraphics can differ by at least
  eight bits. Resampler drift is large enough to break the strict threshold.

## Accepted design

Hashing is Swift-only for this delivery. CubbyKit uses CoreGraphics for both
library thumbnails and downloaded Cubby thumbnails. The web app and Worker
store hashes supplied by the native app and do not calculate hashes for web,
MCP, or other uploads. `algorithmRevision` is currently the literal `1`; a
future algorithm revision must use an explicit migration rather than mixing
hash spaces.

Each `Image` has two nullable private fields:

- `perceptualHash`: 16 lowercase hexadecimal characters.
- `sourceFingerprint`: `{ hash, aspectRatio }`, computed from the native source
  before intentional Cubby edits. This preserves source evidence while the main
  perceptual hash represents the pixels that Cubby stores. Unchanged supported
  files retain their supplied bytes and format, including HEIC.

Both remain outside normal `imageOut` and detail projections. Width and height
remain the aspect-ratio source. A bounded maintenance operation repairs legacy
rows missing either dimension by fetching full bytes and running the existing
integrity verifier. Failures are recorded as storage or metadata failures so a
bad first row cannot prevent later batches from advancing.

The matching tiers are:

| Evidence                                            | Verdict                         |
| --------------------------------------------------- | ------------------------------- |
| hash distance 0–2                                   | in Cubby                        |
| distance 3–6 and aspect ratio within a symmetric 2% | in Cubby                        |
| distance 3–6 without the aspect gate                | possible match requiring review |
| distance greater than 6                             | no match                        |

Revision one renders the complete, orientation-corrected frame at no more than
256 pixels before hashing. The 32×32 CoreGraphics draw uses sRGB, high-quality
interpolation, and a white background for alpha. Grayscale weights are
0.299/0.587/0.114. The unnormalized DCT-II includes DC in its top-left 8×8;
the threshold is the mean of sorted coefficients 31 and 32, ties produce zero,
and row-major coefficients map from the most-significant bit down. Grid
thumbnails and selected-photo requests remain separate PhotoKit requests.

Only strong matches receive an In Cubby checkmark. Possible matches remain in
the Not in Cubby filter and require an explicit reuse/add decision in review.
An unavailable server index leaves unmatched assets visibly unchecked. A
recognition badge does not certify the resolution of an older upload.

The server exposes these revision-one contracts:

- `image.hashIndex` returns all live, uploaded, non-PDF, displayable images as
  `{ id, perceptualHash, sourceFingerprint, width, height }`, plus `{ id, url }`
  repair work for rows whose perceptual hash is null.
- `image.setPerceptualHashes` accepts at most 50 items. It fills only null
  hashes, preserves existing canonical values and source fingerprints, and
  returns canonical stored results plus unavailable image codes.
- `image.uploadImage` accepts optional revision, hash, source fingerprint, and
  dimensions. Older callers remain valid. The metadata is written with the
  pending row, before the object upload is finalized.
- Native reads one image through the kernel `entity.detail` route
  (`CubbyClient.imageDetail(id:)`).

Attachment updates deduplicate incoming image IDs, ignore an already-active
link, preserve its order, append only new links, and still promote a retried
pending image to `UPLOADED`. Live-row and upload-state checks occur before the
join write.

## Picker and progressive checking

The app uses a `LazyVGrid` over `PHFetchResult` with
`PHCachingImageManager`. Full-library authorization enables badges and the
unmatched filter; denied or limited authorization falls back to the system
picker. The per-asset cache is keyed by Photos `localIdentifier` and
`modificationDate` and follows `PHPhotoLibraryChangeObserver` updates.

Opening the picker does not wait for a global first-run hash pass. It fetches
the server index once and gives visible, user-requested assets the first work
turn. A background scan then converges across the whole authorized library in
bounded batches. Progress is visible, and filtering applies to the checked
range until that scan finishes. This keeps first interaction bounded on large
phone libraries while still producing a complete local result.

Repair uses four concurrent downloads and writes up to 50 hashes at a time.
There is no daily gate or terminal repair cap. Selected photos require a usable
revision-one index and successful fingerprinting, while unrelated failed repairs
leave coverage incomplete without blocking Add. Account or host changes cancel
the active work and discard server verdicts. Local hash-cache writes are atomic,
retain one modification version per asset, and prune deleted assets.

## Sightings

A strong match (hash distance 0–2, or 3–6 inside the aspect gate) from a
member's own library is also reported to the server as an `ImageSighting`
(a child row of the Image, not an entity): one row per (image, member, cloud
asset) carrying the asset's capture date and offset, location, camera, media
subtypes and match evidence, written through the native `image.recordSightings`
operation (idempotent on the asset key) by `LibraryMetadataSync` in bounded
batches, only while the install participates in automatic work. Sends are
serialized in pages of at most 50 sightings. After acknowledgment, each sent
marker is checkpointed in its own local SQLite write before the next page starts.
Keep these writes independent: if a later marker fails, earlier markers must
survive so a newly available cloud mapping cannot resend an accepted sighting
with a different asset key. The server
derives the image's capture fields and capturer from its sightings — see
[ADR 0005](adr/0005-image-capture-provenance-from-sightings.md).

## Uploads and Garden dates

Photos is a permanent iPhone tab and Mac sidebar destination. Identify remains
available inside Capture and through navigation links and shortcuts. Existing
Add Photo, Garden, camera, Files, and system-picker entry points remain available.
The permanent browser supports ordered selections backed by asset references;
full-quality files are materialized in order. Bulk import runs use bounded concurrent
file uploads, with progress for each completed transfer before chunk finalization. Photos edits use the
current rendition; unedited assets export their original encoded bytes rather
than PhotoKit's rendered JPEG, preserving PNG alpha and source metadata. Live
Photos contribute their still image, and unsupported or
over-50-MiB files fail explicitly. Subject lifting is an intentional full-resolution
edit. Temporary encoded files remain alive through retries and are removed when
their last owning reference is released.

Destination creation uses the generic image-ingress declaration. Garden-entry
creation and capture-date prefills follow [Garden](garden.md#native-photo-import-and-calendar).
Saved entry/upload IDs survive retries; a destination stays fixed once a batch
starts so recovery cannot split writes across locations.

## Native import-run lifecycle

An explicit photo import continues independently of the Automatic work setting.
Done closes its sheet without cancelling. Cancel remaining work records durable
cancellation, stops unfinished device transfers, finalizes already transferred
photos, and seals that upload batch; imported Images remain. Preparation and
upload failures retain the selection, offer individual Retry controls, and require
an explicit Continue without failed photos before omitting them. Done clears only
confirmed imported photos from selection. View import reopens local progress;
Review item groups is shown only after proposals actually exist.

The native app owns a journal in Application Support, excluded from backup, and
copies selected files before starting uploads. A selection journal records Photos
asset identifiers before iCloud downloads begin. The upload journal replaces it
only after all ready files are owned, retaining the run request, durable batch UUID,
admission offset, presigned upload targets, completed PUTs, finalizations, analysis
results, and cancellation. Run creation and admission replay that UUID; append
positions use the server's reserved offset. A batch seals after its last chunk,
before optional local Vision analysis, so device analysis never delays grouping.
Confirmed, successfully analyzed work removes its journal and duplicate files.
Cancelled batches awaiting server sealing settle on reopening without restarting
uploads.

New device work waits for unmetered, unconstrained Wi-Fi or wired Ethernet,
Low Power Mode to turn off, and thermal state
below serious. Its current waiting reason is visible; elapsed time never overrides
these gates, and explicit imports do not require charging. On iOS, file PUTs use a
background URLSession with journal-owned files readable after the first unlock.
Background-processing expiry interrupts preparation or analysis and detaches the
Swift upload waiter while the OS-owned file transfer continues; reopening reattaches
to it. On Mac, closing the last window leaves the process and imports running;
Quit ends the process, and reopening recovers its journal.

Each new Run stores the Cubby / Pi or Claude / Codex choice. Cubby groups once all
upload batches are sealed and required descriptions settle; an external Run offers
a copyable agent prompt when ready. Adding photos warns that Cubby replaces all
unapproved groups and edits while retaining approved items. Failed descriptions
offer per-photo retry or explicit exclusion, preserving the Image and its bytes.
The finalize request carries the same library provenance block as manifest imports,
so capture date, offset, location, camera, and the import sighting survive without
optional Vision analysis.

A run-specific Live Activity starts with a push token, shows local upload progress,
and registers that token for server updates through describing, grouping, handoff,
attention, review, and completion. Debug uses development APNs; Release uses
production. Signed delivery requires a Push Notifications-enabled App ID/profile
and configured Worker APNs credentials. Unsigned builds and simulator checks do
not establish locked-device transfer or APNs delivery.

Optional **Notify me when ready** is a per-import opt-in. It requests the existing system alert permission and registers the standard APNs device token independently of Live Activities; readiness, handoff, and attention alerts open the import Run. Both token registrations derive their app identity from the generated bundle identity, so Mac development tokens use the development bundle's APNs topic. APNs environment remains a separate Debug/Release choice. Foreground reconciliation also updates and ends the Run Live Activity from server lifecycle state, so a foreground app does not depend on APNs delivery. Signed provisioning with Push Notifications enabled for both bundle identities, Worker APNs credentials, and real-device delivery remain deployment acceptance checks.

A failed transfer can be retried individually or explicitly excluded. Both paths continue all untouched later chunks before sealing the batch; exclusion never deletes an uploaded Image. Optional device-analysis failures can be explicitly skipped. Settled or cancelled batches delete their journal-owned original copies; preparation copies are removed when the upload journal owns them or preparation is cancelled. Recovery isolates each journal and each unavailable selection entry, so one corrupt journal or missing asset cannot hide other imports.

Recovery first consumes any already completed background PUT result. If that result is HTTP 403 and the URL's signed `X-Amz-Date` plus `X-Amz-Expires` proves it expired, the importer restages only that photo and retries once automatically with a fresh URL. It preserves finalized photos and the batch UUID. Other 403 responses, malformed expiry metadata, and a failed renewed attempt remain explicit attention; they do not trigger unconditional retries.

An admission attempt is persisted before `createRun` or `admitBatch` HTTP. Cancellation with an uncertain response replays that same idempotent intent to recover the batch identity, then seals it; the journal and originals remain until the seal is acknowledged. Sheet retirement waits for cancellation settlement before clearing confirmed selection IDs, and retains the remaining selections for an explicit later import.

## Device validation

The synthetic native input journey selects the newest 25 distinct pixel fixtures
from the authorized Library grid using fresh accessibility refs, then verifies
original digests, capture dates, import Sightings, sheet-close continuation, and
explicit group approval without automatic financial or inventory writes. The
Review item groups action targets the proposed-items section directly through
the Run's shared contents navigation, ahead of the per-photo processing rows. The
separate system-picker scripts retain the denied-library entry path. Fixture
setup grants library access to the simulator app without resetting its library;
each fixture batch has distinct original bytes so older batches cannot satisfy
the digest readback.

PhotoKit parity keeps exact source-byte, edited-rendition, alpha, and orientation
checks. Thumbnail and full-file perceptual hashes use the shared production
`PhotoMatchVerdict` strong-match decision: PhotoKit and ImageIO resampling can
produce a small hash difference without changing the duplicate decision. Export
refreshes a retained asset snapshot before checking whether it has edits.

Physical iPhone first-run throughput, memory and thermal behavior, Photos
limited-access fallback, progressive-filter interaction, and PhotoKit
current-rendition fixture parity still need device checks. Mac interaction
requires an unlocked Photos library with authorization. Simulator and browser
emulation do not establish physical-device behavior.
