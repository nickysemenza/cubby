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
years. In the experiment, three of five filename-matched pairs were different
photos. Perceptual similarity is therefore the durable primary signal.

## Experiment (2026-09-13)

The experiment computed a 64-bit DCT pHash (32×32 grayscale, DCT-II, top-left
8×8, bits above the median) through CoreGraphics on both sides. It compared the
`cdn-cgi` 256px thumbnail of all 5,807 Cubby images with local 256px thumbnails
of all 6,555 Photos-library assets from the previous 12 months, fetched by a Mac
PhotoKit CLI. Distance is Hamming distance; the median threshold makes every
distance even.

| Distance | 0 | 2 | 4 | 6 | 8 | 10 | 12 or more |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Nearest pairs | 40 | 11 | 5 | 2 | 14 | 53 | 5,680 |

- Distances 0–2 were all real matches. Renames, HEIC-to-JPEG conversion,
  downscaling, and EXIF removal remained at distance 0; the second-nearest
  asset was usually 12–18 away. Portrait rotation also agreed across both
  sides.
- Distances 4–6 were mixed: four real and three false. Each false result was a
  square catalog image matched to a 4:3 photo, so an aspect-ratio gate rejected
  it.
- Distances 8–10 were all false. Low-texture library images acted as attractors
  for scraped product-on-white images, and none was aspect-consistent.
- Only about 55 of 5,807 Cubby images were library photos. The threshold is
  supported by a wide positive separation and 5,750 non-library negatives with
  no false match at distance 0–2, but the 4–6 band should be measured again
  after Cubby holds a few hundred real photos.
- The 37 images exactly 2048px wide came from in-app `CameraPicker` captures,
  which never entered Photos, and matched nothing. Pixel dimensions describe
  some export paths but do not reliably identify phone photos: 2000×1500 was
  21/21 phone photos while 1600×1600 was mostly retailer noise.
- About 8% of library assets had another library asset within distance 6 due to
  bursts, retakes, and duplicates. Treating a burst twin as probably in Cubby
  is the desired behavior.
- Hashing the same bytes with Sharp and CoreGraphics differed by at least eight
  bits in 8% of cases. The resampler caused the drift, which is large enough to
  break the strict threshold.

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

| Evidence | Verdict |
| --- | --- |
| hash distance 0–2 | in Cubby |
| distance 3–6 and aspect ratio within a symmetric 2% | in Cubby |
| distance 3–6 without the aspect gate | possible match requiring review |
| distance greater than 6 | no match |

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
- `image.detail` is available to the native client through the generated API.

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

## Uploads and Garden dates

Photos is a permanent iPhone tab and Mac sidebar destination. Identify remains
available inside Capture and through navigation links and shortcuts. Existing
Add Photo, Garden, camera, Files, and system-picker entry points remain available.
The permanent browser supports ordered selections backed by asset references;
full-quality files are retrieved and uploaded sequentially. Photos edits use the
current rendition, Live Photos contribute their still image, and unsupported or
over-50-MiB files fail explicitly. Subject lifting is an intentional full-resolution
edit. Temporary encoded files remain alive through retries and are removed when
their last owning reference is released.

Add to offers existing image-attachable records and New garden entries. Garden
imports choose one bed/location and optional planting, group photos by local
Gregorian capture day, and review editable observation drafts with a note per day.
Photos creation dates take precedence, including corrections in Photos; file
fallbacks use capture metadata, never modification/upload dates. Undated photos
need an explicit date. Prefills say Date from photo; explicit date edits survive
selection changes and existing-entry dates are preserved.

Garden review enforces 20 photos per entry before uploading. Saves are sequential;
confirmed entry IDs and successful upload IDs survive failures. Reuse, including
references to other selected photos, transfers no image bytes. The destination
stays fixed after a batch starts so retries cannot split its saved days across
locations. Ordinary Garden forms retain their existing selection flow, with a
12-photo chooser bounded by remaining entry capacity.

## Delivery and verification status

Implemented server work includes the additive columns and database format
constraint, upload metadata persistence, hash-index and fill-only hash APIs,
idempotent shared association writes, dimension repair, generated OpenAPI and
native operation bindings, repository tests, and the application-schema
snapshot. Native implementation includes the Photos browser, full-quality
encoded-file upload pipeline, progressive matching/review, existing picker
integration, capture-day Garden imports, cancellation, and retry checkpoints.

The server lane passes `pnpm check`, focused unit/OpenAPI/schema checks, and the
real-PostgreSQL image family (87 tests). CubbyKit's full suite passed before the
final cache/lifetime follow-up; cache replacement/pruning tests passed afterward.
App-host matching and Garden retry suites passed before the final lifecycle
follow-up. Final-commit verification is still pending and will be recorded here.

The 2026-09-13 Mac experiment above is measured evidence. Physical iPhone
first-run throughput, memory and thermal behavior, Photos limited-access
fallback, progressive-filter interaction, and actual PhotoKit current-rendition
fixture parity remain device checks. The signed Mac app built and launched;
interactive validation paused at the locked Mac/Photos permission prompt. The
simulator parity suite is opt-in and also requires Photos authorization. These
checks must not be inferred from
the Mac CLI experiment, simulator behavior, compilation, or server tests.

The additive production database expansion is complete; no application code
from this branch has been deployed. The exact SQL, validated constraint,
compatibility order, and completed read-back check are in
[the native photo schema rollout](runbooks/native-photo-library-schema.md).
