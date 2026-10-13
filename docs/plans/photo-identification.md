# Photo understanding and identification

Status: first single-Product suggestion slice implemented. This document
distinguishes the wider agreed direction from this slice; production activation
and measured model-quality evaluation are separate.

## First-slice failure modes

- Image input must never reach text-only Jev through the random decision trial.
- Neither an absent Apple device nor its unsupported description capability may
  prevent cloud decisions or consume failed execution attempts.
- A none-of-these decision must not become a confident Product suggestion;
  scenes and multiple objects must not be forced into a single Product.
- Candidate names are hints, not proof; compare the source with independently
  attached Product evidence, never its own image or a borrowed gallery image.
- Changed/deleted source images must reject late job results. Catalog changes
  and deleted Products must not turn retained suggestions into accepted facts.
- Repeated scheduling reuses work; model results never attach, merge, create,
  or change stock. Reads do not start inference.
- Preserve original and per-provider evidence and confirmed corrections.
- Candidate retrieval is bounded and reports truncation; never present a search
  over a subset as exhaustive identification.

## Agreed direction

- Cover existing-Product identification, multi-item shelf and wardrobe review,
  plants, receipts and documents, finding older photos, and inventory recounts.
  Clothing, packaged goods, and visually similar tools are initial examples.
- Run Apple processing and Clef image decisions as the baseline. Retain results
  once per image/content revision and show them as they arrive; an unavailable
  Apple device must not block available Clef suggestions. Jobs wait for a
  capable device without consuming attempts; content and processor revisions
  define repeat work.
- The baseline covers all admitted Cubby images, with a paced backfill of
  existing images. Local Apple analysis may precede admission; this does not
  authorize cloud processing of otherwise-unselected Photos library assets.
- Identify depicted subjects and propose existing-record matches. Individual
  physical-instance identity requires distinguishing evidence; matching the
  same Product does not establish that two photos depict the same possession.
- Save machine observations and rank suggestions automatically. Consequential
  changes require confirmation: identity attachment, Product creation, merges,
  and inventory changes. Inventory never auto-decrements.
- Escalate automatically through the existing AI Gateway for useful unresolved
  questions during active identification, within an explicit spending cap.
  Historical bulk escalation has a separate budget. Numeric limits remain
  undecided; this design agreement does not enable production processing.
- Establish single-photo Product matching across tools, clothing, and packaged
  goods first, followed by multi-item review and recounts. Search reuses image
  observations from the start. All other named use cases remain in scope.
- Retain independent observations when providers disagree. Member corrections
  take precedence; later machine evidence may flag a confirmed match for review
  but cannot replace it. Include none-of-these and cannot-tell outcomes.
- Multi-subject analysis is automatic and requires no region selection,
  bounding-box editor, splitting, or manual crop repair. Present simple subject
  and record suggestions; unresolved subjects may remain unresolved. This
  removes analysis-tweaking work, not the agreed confirmation of consequential
  identity, creation, merge, or inventory writes. Preserve original evidence.
- Evaluate with reviewed examples across all agreed use cases. Start release
  acceptance with single-photo top-three Product recall, false matches,
  appropriate abstention, time to useful suggestions, and cost. Include
  lookalike variants, unreadable labels, identical items, and absent Products;
  set numerical targets after measuring the existing baseline.

## Pre-implementation evidence

Source inspection, not installed-device or production-settings verification:

- Apple selected-photo analysis already collects OCR, classifications, hashes,
  and Vision feature prints. The library sweep is classify-only. See
  `PhotoAnalysis.swift`, `PhotoClassificationSweep.swift`, and
  `PhotoVisualEvidenceMatcher.swift`.
- Subject lift uses foreground-instance masks. The current lift includes all
  detected instances; it is not a per-object catalog or inventory count.
- `FoundationModelsImageDescription.swift` implements real local image input,
  with compiler >=6.4, iOS/macOS 27, available model, and vision-capability
  gates. Device automatic participation defaults off. Enabling participation
  alone cannot provide an unavailable model capability.
- Server image processing defaults to disabled and paused when no override is
  stored (`repo/image-processing-maintenance.ts`). Actual settings are unknown.
- Cloud descriptions already use the shared `image-description` feature and
  cache. Apple descriptions are a separate revision; current search projection
  prefers a correction or the current cloud description (`repo/search-document.ts`).
- Cubby's Clef decision adapter sent state and typed questions but
  no images before this change (`server/ai/decision-model.ts`). Its randomized Jev/Clef
  routing cannot be assumed to support image requests.
- [Cloudflare's Clef contract](https://developers.cloudflare.com/workers-ai/models/clef/)
  supports up to four embedded images and returns decisions over supplied
  choices, not open-ended descriptions. Published input price is $0.24 per
  million tokens, including image tokens; output is uncharged (checked
  2026-10-12). Candidate retrieval and unknown/none-of-these options remain
  necessary; an option probability is not proof of identity.

## Use-case boundaries to resolve

- Product identity versus a particular physical possession: two identical
  drills may share a Product without being the same item.
- Scene observations versus inventory: visible items, occlusion, repeated
  photos, and old captures do not establish current stock.
- Plant appearance versus cultivar identity: a leaf photo may narrow a species
  without establishing the purchased cultivar or Planting.
- Document classification versus extraction: recognizing a receipt does not
  establish its line items, totals, or links to an existing Purchase.
- Searchable observations versus accepted facts: descriptions should help
  retrieval without silently changing canonical identity or attributes.

## Open decision frontier

1. Numeric frontier spending limits and historical escalation budget.
   Apple waiting is resolved: retain `waiting_for_device`, consume no failed
   attempts while no eligible worker exists, and resume when one is available.
   Other results remain usable. Reuse results for the same content and processor
   revision; model/prompt/schema changes explicitly change that revision.

Then settle candidate retrieval and review surfaces against the selected
policies. Preserve separate original and cutout evidence: cropping can remove
labels and scene context. Persisted design decisions do not establish that any
runtime behavior has been implemented or enabled.

## Simplicity and storage assessment

Keep the interface automatic and reuse existing storage and scheduling. The
first Product-matching slice is a bounded integration change; delivering every
listed use case remains substantial work, especially candidate recall and
ambiguous multi-object scenes.

`AiAnalysis` already stores per-image feature/provider/model results as JSON,
with prompt/schema revisions and input fingerprints. Independent Apple, Clef,
and frontier observations do not by themselves require a new table. Typed
result contracts and consumer changes are still required. Image jobs already
have `waiting_for_device`; the dispatch path uses it and a persisted regression
asserts idle cycles do not consume attempts. Reuse this behavior.

The first slice adds `identify_image` to the existing job-kind CHECK. It retains
structured Clef observations in `AiAnalysis`; no new table or queue is needed.
Apple description, cloud description, subject lift, and identification are
independent durable jobs. AVIF identification waits without consuming attempts
for a verified JPEG snapshot from the existing normalization job; AVIF catalog
references are excluded from this first comparison path. The native compatibility version advances because
older clients cannot decode the new job kind.

## Implemented first slice

Clef classifies composition, selects an existing category, shortlists bounded
catalog candidates, then compares the original rendition with up to three
independently attached Product references. Source images cannot match themselves
by id or content hash. Current corrections or cloud descriptions can improve
lexical retrieval when already available. Missing descriptions never block
Clef. Category selection and alphabetical roster caps can miss relevant Products;
truncation is visible and model probabilities are not calibrated confidence.

Current observations appear as unconfirmed suggestions in the existing image
associations report and analysis summaries. No inference runs on reads. No
identity, Product, merge, or inventory write occurs. Deleted targets and changed
source content are filtered out of retained results.

Multi-object photos, documents, and scenes are classified but abstain from
single-Product matching. Multi-subject proposals, image-derived search expansion,
measured quality evaluation, and paid frontier escalation remain follow-up work.
The existing cloud-description path is preserved. No new frontier spending or
production setting is enabled by this change. The existing paced backfill can
schedule all baseline kinds after deployment and activation.
