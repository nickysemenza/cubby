# Cubby — Work List

The canonical backlog, grouped by area. Items are not ranked. Each item starts
with one status marker naming its next blocker:

| Marker | Meaning                                                |
| ------ | ------------------------------------------------------ |
| 🟢     | Ready: decided, no schema change                       |
| 🧱     | Ready once schema or migration is planned              |
| 🤔     | Needs a decision, investigation, or evidence           |
| ⏳     | Waiting on a named trigger; promote only when it fires |
| 🔭     | Long-term direction                                    |

An unresolved decision or missing evidence outranks an eventual schema change.
**Probably not anytime soon** parks wanted-but-unpulled work, **Dormant
schema** lists built-but-unused tables, and **Operational passes** are
household data work rather than software; those three carry no markers.

Keep entries concise and outcome-oriented. Record only constraints that would
change selection or implementation, with a pointer to the code or focused doc
that owns the full contract. Shipped and superseded work leaves this file; git
history is the archive. Permanent product constraints live in the
[Tenets](../README.md#tenets), not in rejected-idea essays here.

---

## Images & photos

- 🤔 **Review existing duplicate research images.** New research admissions
  reuse same-byte item attachments under the Product lock and retain each source's
  support. Existing duplicate galleries and historical images without SHA-256
  need an approved preservation/cleanup plan. Preserve member photos, cover order,
  labels and genuinely different variants; do not delete household records from
  a forward-prevention fix.

- 🧱 **Full capture metadata from the Photos library.** The library match path
  (`LibraryMetadataSync` → `image.recordSightings`) already backfills
  `capturedAt` and location for every strong perceptual-hash match across the
  whole library, including photos never uploaded from that device, but sends
  `camera`, `capturedAtOffsetMinutes`, and `placeName` as nil
  (`PHAsset+LibraryAssetFacts.swift`, `LibrarySighting.swift`); production has
  0 of 6,292 Images with `captureDeviceLabel` or `capturePlaceName`. For strong
  matches, load the asset's image data (may download the iCloud original) and:
  fill those gaps; store the raw ImageIO EXIF/TIFF/GPS dictionaries (minus
  MakerNote and binary values) in one jsonb on `ImageSighting`, since edits
  differ per library copy; and have server extraction
  (`services/image-metadata.ts`, `embeddedMetadata`) keep the same raw
  dictionaries for uploads that still carry EXIF. Nothing reads shutter,
  aperture, or ISO yet; they are kept so the bytes never need refetching.

- 🤔 **Identify what is in a photo.** Photo import stops at the entity type,
  and web location detection matches by name only. In order:
  1. 🤔 Compare detected items visually against Product covers and
     subject-lift cutouts, not only by exact name then semantic name
     similarity. Needs an eval set like `inventory-detection-evals.ts`.
  2. ⏳ Server vision ranking of a single record (`photo-import.identify`, a
     `defineFeature` sibling of `product-identification`, fed into
     `PhotoEvidenceScorer` as an identity score) when deterministic evidence
     still leaves the chooser in default order often enough to matter.

- ⏳ **Shared Vision gate for photo analysis.** The classification sweep (2 concurrent) and the review sheet's
  `LocalPhotoAnalyzer` (4) share no Vision gate. Promote if a review-sheet
  analysis measurably slows while the sweep runs: add a `PhotoVisionGate`
  actor both acquire, with the sheet yielding the sweep.

- ⏳ **Product match queue recall and cost.** Each unfocused queue read now
  logs `queue read coverage`: vector lookups, unseeded photo Products, and
  photo Products with no candidate at all, split by whether they were seeded.
  Promote widening, caching, or write-time detection only when those logs from
  a real wardrobe import show unseeded photos without candidates that a person
  later matched (`apps/web/src/server/services/product-match.service.ts`).

- 🤔 **Reproduce macOS photo-match export inside the sandbox.** Capture the
  error chain and sandbox denial for Downloads, Desktop, and an iCloud
  Drive/file-provider destination before choosing between exact-file
  authorization, coordinated writes, or per-file copying. Keep the existing
  user-selected entitlement; no broad access or persistent bookmarks.

- ⏳ **Image provenance follow-ups.** Each promotes on its own trigger:
  - _Geolocated photo → nearest Location suggestion_ in import review, once
    Locations carry coordinates.
  - _Capture date as inventory evidence_: emit a sighting's `capturedAt` as a
    timeline event when the inventory timeline next needs external evidence.
  - _Cross-member duplicate review_ reusing `PhotoMatchStore` candidates once
    ambiguous attributions accumulate.
  - _Per-feature participation sub-switches_ if the single Automatic work
    switch proves too coarse.
  - _`MenuBarExtra` companion status on macOS_ once background work is
    visible elsewhere.
  - _Hash-repair egress budget_: `PhotoMatchStore.repair` downloads full
    originals; cap per session and prefer Wi-Fi when cellular use is observed.
  - _Shortcuts App Intent "Log this photo to Cubby"_, once the import path
    carries the `library` block.
  - _Map / per-place / per-trip photo filters_ over `captureLocation`.

- ⏳ **Decode bytes in image verification.** Promote when a corrupt or fully
  transparent cover is next found by eye. `inspectImageFile`
  (`services/image-integrity.ts`) never rasterizes, so
  `product_enrichment.verify_images` reports `verified` for files that will not
  render; a subagent citing it is not proof of a good image.

- ⏳ **Exact entity attribution for `image.attach_files`.** Promote if
  mixed-entity batches distort the MCP usage dashboard; telemetry attributes a
  batch to its first item's entity.

- ⏳ **Apparel photo routing and size/color fields.** Routing categories are
  plants, food, documents, and home; size and color live in the Product name
  and notes, one Product per variant. Revisit an apparel category once the
  hosted coordinator routes photos, and structured size/color once wardrobe
  filtering by size is wanted.

- ⏳ **Driven simulator smoke for the photo flow.** Promote when the next
  SwiftUI identity/state bug ships. `simctl addmedia` two fixture photos, drive
  select A → Add to… → Cancel → Clear → select B → Add to… via Axiom `xcui`,
  and assert the hero names B. Run from `apple-check.sh` behind a flag, outside
  the pre-push gate.

See also the image operational passes at the end of this file.

---

## Purchases, finance & household ledger

### Import and resume orders reliably

- ⏳ **Conditional purchase-import browser extension.** Promote only if the
  Apple-event browser bridge repeatedly fails to background its window, cannot
  avoid Chrome's JavaScript-from-Apple-Events setting, or cannot provide
  reliable capture. Thin: window ownership and capture only, no Cubby
  credentials or business writes.

- ⏳ **True full-page browser evidence.** Promote a stitched full-page capture
  only when the viewport snapshot misses evidence a real import needs; never
  label viewport capture as full-page.

- ⏳ **Gmail discovery re-authentication.** Promote when production Gmail
  returns 401/403 after refresh-token expiry or revocation: actionable
  reconnect, resumable Problem, never an "empty mailbox".

- ⏳ **Finish terminal browser cleanup.** Promote when logs show browser
  commands surviving a terminal run or an owned window left visible.
  Terminalize queued commands by run generation, send one terminal signal,
  minimize only Cubby's window, and log discarded work.

- ⏳ **Typed pagination and final grocery evidence.** Promote when a vendor
  exposes pagination or grocery pages whose last page the hints miss.

### Reconcile charges and refunds

### Review and apply corrections

- ⏳ **Re-run the purchase decision evaluation before rerouting.** Run
  `pnpm --dir apps/web eval:purchase-decisions` (opt-in, billed) before
  changing matching or purchase-run model routing. Baseline, 2026-10-03:
  GPT-6 Sol high 12/12 correct, 0 unsafe, about $0.58 per run; GPT-6 Luna
  high 8/12, 1 unsafe (duplicate Product) and three runs that misread the
  extractor result. That historical result does not establish quality for the
  current source-first researcher. The selected runtime starts purchase and
  Product work on Luna/medium and escalates a continuing domain refusal to
  Sol/low. Recheck those candidates against the same sources and budgets;
  scripted provider-boundary coverage proves routing, not model judgment.
- 🔭 **Grow the purchase evals from member dismissals.** A dismissed mail
  link, a dismissed import finding, or a cancelled automatic import is a
  labeled mistake. A scheduled worker skill would read recent ones and draft
  synthetic look-alike cases for `purchase-decision-eval.fixtures.ts` (never
  real household data), opening a PR for review. Dismiss stays one tap with
  no reason field, and nothing tunes itself.

---

## Import pipeline architecture

The model owns adaptive investigation and semantic judgments. Code owns source
retention, admission, durable recovery, replay, ownership and domain writes.
Pi already hosts the researcher; the [simplification audit](plans/research-simplification.md)
records the remaining deletion candidates and SDK comparisons. The first two
slices merged in [#1784](https://github.com/nickysemenza/cubby/pull/1784) and
[#1797](https://github.com/nickysemenza/cubby/pull/1797), removing 1,534 net
tracked lines including tests and documentation. The retired vendor-search
Workflow, binding, schemas and bespoke progress presentation are gone; historical
Runs remain readable through generic reports and cannot execute again. No tables,
household data or compatibility adapter were removed or introduced by these
slices. Review, exact-head hosted checks and deployment completed; live mailbox
acceptance remains open. Browser transport contracts remain in
[infrastructure](infrastructure.md#browser-bridge).

Delivery order: finish economical requests and deterministic execution bounds,
then household and record-level status visibility, then the remaining source,
browser and schema consolidation. Live research and new automation are paused
at the member's request. Keep their retained progress; perform real-model,
mailbox and authenticated-device acceptance only after explicit resumption.

- 🟢 **Stop repeated logical failures across a Run.** One browser-command retry
  and the current 256-generation Run limit do not bound repeated commands under
  new operation IDs early enough. [#1808](https://github.com/nickysemenza/cubby/pull/1808)
  adds a reviewed three-distinct-call bound for identical thrown service failures
  using existing durable Run state. Its exact-head hosted checks and scripted
  acceptance passed, it merged and production deployment succeeded. Returned
  browser `blocked` replies share that bound in
  [#1813](https://github.com/nickysemenza/cubby/pull/1813), independently reviewed,
  exact-head hosted tested, merged and deployed. Corrective resolution refusals
  already have a three-zero-progress-attempt allowance per task, retained through
  completed operation receipts. Bound Mac command receipt duration and distinct retry links now ship through
  the shared Run operation shape and generic report in
  [#1820](https://github.com/nickysemenza/cubby/pull/1820), independently reviewed,
  exact-head hosted tested, merged and deployed. It never substitutes suspended
  operation wall time. Visible acceptance and total active-time accounting remain
  open. Pause
  repeated unchanged failures with their raw last observation. Member sign-in,
  permissions and Mac-offline waits do not consume active time. Reuse Run state
  and existing usage/cost authorization; do not introduce another job engine.

- ⏳ **Accept reviewed Vendor capture profiles.**
  [#1831](https://github.com/nickysemenza/cubby/pull/1831) ships typed proposals
  through the shared research resolver and existing Run review for learned
  order-history URLs, sign-in hosts, reviewed additional hosts and pagination
  hints. Source/account/current-profile binding, explicit member host
  authorization and stale-review refusal remain deterministic. Generation,
  focused regressions, independent review, synthetic UI acceptance, exact-head
  hosted checks, merge and production deployment completed. Installed-client
  review and real-source acceptance remain open while live research is paused;
  page content cannot grant itself host authorization.

- 🤔 **Recognize email-code and hosted sign-in.** Combine retained page
  interpretation with deterministic host/path checks. Exercise a hosted customer
  account, redirects, email-code login and slow navigation through the real Mac
  bridge. Model classification alone must not broaden browser permissions.

- 🟢 **Notify when a Run needs the member.** Extend the Mac's existing notifier
  beyond prolonged offline waits and completion.
  [#1819](https://github.com/nickysemenza/cubby/pull/1819) persists
  account/Run/reason pause edges, names sign-in, Screen Recording and Apple
  Events fixes, and raises the owned account window for a fresh permission
  pause. Synchronous dispatch validity is invalidated when a pause resolves or
  its controller is replaced, so an earlier actor check cannot raise a stale
  window. Headless persistence and suspension regressions pass after intended RED;
  Mac App compilation, independent review, exact-head hosted checks, merge and
  deployment passed. Real notification/owned-window delivery remains pending. Coordinate with the
  activity strip and attention-first workspace below.

- 🟢 **Re-derive retained captures without rewriting committed history.**
  `PAGE_DERIVATION_REVISION` stamps captures.
  [#1818](https://github.com/nickysemenza/cubby/pull/1818) ships the shared
  `run.rederiveCapture` operation appends revision-keyed interpretation receipts
  under the original command host authority, reports changed capture fields and
  source-supported fact fields in the generic Run log, and preserves original
  bytes, checksums, accepted claims and replay results. Its settled-capture and
  checksum regressions, synthetic browser acceptance, independent review,
  exact-head hosted checks, merge and deployment passed. Installed-client and
  live acceptance remain pending. Fresh research remains a separate Run.

- 🤔 **One source contract, without a second extractor.** Mail, browser, file
  and photo readers should return retained text, links, media, typed identifiers
  and selected-variant context through the existing research observation spine.
  Generate adapters over shared domain services. Preserve original-media delivery
  and each source's retention policy; a giant flattened text call is insufficient.

- 🤔 **Repeatable real Mac/browser acceptance.** The fixture-retailer journey
  still requires a signed app and persistent Automation/Screen Recording grants.
  The #1775 guarded installer was exercised against clean main `fa218505e`:
  the signed 2.15.0 app replaced 2.14.0, retained its session and existing
  Automation/Screen Recording grants, loaded server-backed Today, and reconnected
  Browser Sync. That establishes installed-client compatibility and permission
  continuity; authenticated capture and screenshot roundtrips remain unverified.
  Reuse this path before adding signing infrastructure. Choose a self-hosted runner or a harness that removes those prerequisites,
  then cover redirect readiness, email-code sign-in and slow navigation with
  sanitized exact-revision artifacts. Installed-app behavior remains an
  acceptance requirement even when a signed build succeeds.

- 🟢 **Vendor-platform page-reading regressions.** Keep synthetic storefront
  captures for Shopify, WooCommerce, BigCommerce and a marketplace. Assert
  supported variant semantics and truncation rather than incidental DOM markup.

- 🟢 **Server-owned account status in Mac Settings.** Project browser-sync
  authorization, socket connectivity, current Run/step and last successful sync
  through the existing server status contract instead of local socket state alone. Local
  browser execution now derives Run links from the existing command registry; the
  connection and import-plan columns remain distinct, and last commands link their
  actual Run. The shared sync plan separates server broker connectivity from
  persisted account status and reuses the VendorAccount last-completed-Run
  derivation. Native account labels use the generic manifest.
  [#1830](https://github.com/nickysemenza/cubby/pull/1830) completed focused
  persisted-state regressions for pause visibility, failed-attempt history and
  owned broker reads, independent review, exact-head hosted checks, merge,
  deployment and synthetic UI acceptance. Current target/step and installed
  authenticated-device acceptance remain open.

- 🟢 **Generate remaining Mac agent-route contracts.** Accounts and debug batches
  now use shared generated Vendor/Run operations in
  [#1817](https://github.com/nickysemenza/cubby/pull/1817);
  both Mac callers migrated, the old HTTP routes/request helper were deleted,
  and debug schemas moved into the shared package. Persisted eligibility,
  mixed-owner rejection and replay regressions, native compilation, independent
  review, exact-head hosted checks, merge and deployment passed. The wire break
  requires Apple compatibility 2.17; installed-client acceptance remains pending. Keep the separately owned MCP HTTP handler out of this work.

- 🤔 **Separate debug observations from replayable operations.** Replace
  `__debug_event` special cases with an existing bounded event/report path if it
  removes storage/read code. Preserve raw diagnostics, retention and historical
  rendering. The [current storage audit](plans/research-simplification.md#debug-observation-storage)
  found no equivalent reusable event store; moving these rows to RunProgress
  would add contracts and a preserving migration without demonstrated reduction.
  Keep this conditional; do not introduce another log table merely to remove the
  projection branches.

- 🟢 **Complete Run cost/time explanations.** The Runs list shows cost,
  duration and attempts, and detail shows model timing. Browser command receipt
  time and distinct retry attribution ship through the shared projection in
  [#1820](https://github.com/nickysemenza/cubby/pull/1820). Total active-time
  accounting and subscription savings remain open; reuse the existing AI usage
  ledger. Unknown intervals and prices stay unknown, and suspended wall time
  never substitutes for active work.

## Runs, enrichment & browser capture

Run remains the one unit of unattended work. Parent/child lineage, retry
predecessors, causes, attempts, `mail_import` and `mail_discovery` shipped with
`0025_purchase_research`; its approved preserving production cutover and schema
readback were completed. Do not reapply that migration. The shared activity
projection owns list/status presentation. Shipped schema is distinct from live
research acceptance.

- 🟢 **Explain household work before listing its attempts.** Show what is working
  now, waiting and why, needs a member decision, and what happens next. Group
  related discovery, purchase research, enrichment and retries using existing
  lineage. Grouped matching working, waiting, review, failed and completed
  attempt counts now ship independently of root status and Product verification.
  All-page matching-attempt totals now use the same state policy in flat and
  grouped queries, with one server-composed summary in web and native. Persisted
  pagination/filter/empty-result coverage and synthetic web acceptance passed.
  Independent review, exact-head hosted checks, merge and deployment completed
  in [#1826](https://github.com/nickysemenza/cubby/pull/1826). A household overview with reasons and next actions remains
  open. Finish a
  record-level view of processed emails, matched orders, linked
  Purchases and enriched Products with processing time, outcome, evidence and
  links. Include supported unchanged facts and unresolved work, not only audit
  writes. Keep classification, linking, financial review and verification
  distinct. Reuse shared entity/report presentation; disclose count scope rather
  than extrapolating loaded pages into household totals.

- ⏳ **Accept research root grouping in the clients.** The shared activity
  projection groups research descendants and image jobs through retained live
  causal parents, with filtered, cursor-paged children. Persisted-state
  regressions cover nested work, deleted ancestors and independent legacy rows.
  Native Activity now uses the shared grouped/child reads, expandable related
  rows and the existing inspector. Focused transport and isolated model
  regressions passed after RED; the Mac UI compiled. Independent review,
  exact-head hosted checks, a sanitized isolated Mac journey and deployment
  completed in [#1828](https://github.com/nickysemenza/cubby/pull/1828). The
  journey covers filtered parent context, descendant failure and child-inspector
  navigation. Installed household acceptance remains pending. Historical null
  lineage remains independent and retry predecessors never imply parentage.

- 🟢 **Derive research-purpose presentation consistently.** Audit the duplicated
  purpose sets in shared constants, agent inputs, Run declarations and Workflow
  contracts. Import report eligibility now comes from the shared Run schema, including
  `mail_import`, with generated Swift and one web/server predicate. Exact-head
  hosted checks and checksum-verified E2E artifacts passed before PR #1793
  merged; production deployment succeeded on `01dda8634`. Native visible
  report acceptance remains pending. The [completed purpose audit](plans/research-simplification.md#run-purpose-audit)
  confirms that agent execution, discovery, targeted launch, report eligibility,
  write rights and the Imports saved view intentionally cover different
  capabilities. No additional purpose-list consolidation is justified.

- ⏳ **Accept purchase-source-first Product research.** Supply usable original-mail
  selectors and existing order-detail URLs with accepted order lines shipped in
  [#1801](https://github.com/nickysemenza/cubby/pull/1801). The maintained skill
  recovers missing originals through owned email and authenticated account history
  before broader name search. Mail HTML links now use the shared bounded typed
  observation links as well as readable text, so text truncation cannot hide exact
  order/item leads. [#1835](https://github.com/nickysemenza/cubby/pull/1835)
  completed persisted original/replay and URL-policy coverage, independent
  review, exact-head hosted checks, merge and production deployment.
  Real-model acceptance remains pending. Validate a real plant and a real
  hardware-retailer Product after deployment; old per-order source associations
  remain explicit gaps until a supported original is recovered. Do not invent
  historical mappings or treat a search match as proof of the purchased variant.

- 🤔 **Verify automatic enrichment dispatch after import commit.** Imports now
  admit Product research through `startProductResearch`, which obtains the
  configured producer when none is supplied. Verify real completion and restart
  behavior; do not restore the removed inline enrichment path or add a second
  completion scheduler.

- 🤔 **Measured fetch/browser routing.** Public reads and authenticated Mac
  capture are separate research tools. Investigate repeated host-specific public
  refusals using retained operation results; a learned routing hint may save
  calls, but source freshness and authenticated-page needs still decide the tool.

- ⏳ **Finish actual research and visible-proof acceptance.** Complete the
  authorized external roster through new Runs using subscription inference or
  explicitly authorized AI Gateway fallback within the existing allowance. Prove original-order/selected-variant identity, matching-value
  provenance, reviewed contradictions and representative images. Populated fields
  and terminal Runs do not establish verification. Use `ImportSourceOrder` /
  `ImportSourceProduct`, including order-history evidence when mail omits the
  variant. Preserve immutable settled targets and report unsupported facts as gaps.
  A usage limit does not require reauthorization. Paid fallback must reserve
  the existing durable allowance before every transmission; unknown prices or
  insufficient budget refuse it. Verify actual spend separately from reservations.
  The bounded live attempt on main `fa218505e` exposed the exact quota code in
  an HTTP 200 `event: error` after `response.created` and `response.in_progress`,
  with no Content-Type. It was canceled after one failed subscription call ($0),
  before further inference. HTTP 429 fallback therefore does not establish live
  paid recovery. A bounded pre-output probe now qualifies the exact stream
  refusal through the shared router and existing admission. #1794 completed
  independent Sol/high and Astra/high review, exact-head hosted checks and merge.
  A fresh bounded attempt on deployed main `01dda8634` still returned the quota
  without paid admission or transmission; it was canceled after one failed call.
  The actual stream-admission rejection and live paid recovery remain unresolved;
  do not infer eligibility from preceding event names alone.

- ⏳ **Accept economical research requests and routing.** Mail routing now uses
  bounded visible text, exact links and retained media descriptors instead of
  HTML layout; incomplete views remain uncertain and original retention is
  unchanged. The independent support assessor now uses Sol/low. The researcher
  starts on Luna/medium and escalates continuing domain refusals to Sol/low.
  [#1806](https://github.com/nickysemenza/cubby/pull/1806) merged and deployed
  request-only delivery of repeated attachment bytes once, preserving every
  observation binding and the existing admission limit. Complete repeated order
  context sharing in [#1807](https://github.com/nickysemenza/cubby/pull/1807)
  has independent review, exact-head hosted checks and scripted acceptance;
  merge and production deployment completed. Real-model comparison remains
  pending while live research is paused.
  Request-sharing changes must preserve every source binding and complete order
  context. Compare supported outcomes, physical calls and transmitted bytes on
  unchanged synthetic sources, then verify real-model quality only when live
  research is authorized. Lower effort and fewer bytes do not establish correct
  purchased-variant judgments or a measured subscription-quota saving.

- 🟢 **Reuse supported existing Products before creation.**
  [#1810](https://github.com/nickysemenza/cubby/pull/1810) replaces bounded
  alphabetical brand-token candidate searches with shared name/alias relevance
  and exposes live candidates when assessing a proposed new Product. Focused
  persisted-state regressions, independent review and checksum-verified
  final-head hosted acceptance passed; merge and deployment completed. Verify real-model reuse after explicit
  research resumption. Existing duplicates require a supported, preserving
  merge plan before household cleanup; matching names alone never prove variants.

- 🤔 **Link enriched seed Products to Plants.** `growsPlantId` is supported,
  but deciding which growing facts belong on Plant versus a purchased seed
  Product remains separate from completing Product identity research.

- 🤔 **Controlled-browser preview.** Show Cubby's Chrome window in a small
  floating monitor that stays visible while browsing other records, like a
  picture-in-picture view. Make it movable, resizable, collapsible, and dockable
  beside Browser Sync or the run console without covering primary actions.
  Support following the active run or pinning one account, with keyboard
  actions to expand, switch runs, and raise or return from Chrome.
  Include account, page title, domain, capture time, and a "Show browser" action.
  Investigate reuse of the latest screenshot versus a low-rate local preview;
  update only
  while visible and never capture unrelated windows or bring Chrome forward
  for a refresh. Distinguish a live view, a last capture, and an unavailable
  preview with its reason. Preview frames become evidence only through the
  existing run capture path. The [browser bridge](infrastructure.md#browser-bridge)
  owns window identity and capture permissions.

- 🟢 **Run activity strip with the next action.** Show the current Run,
  target, latest step, time in that step, and completed/known target counts
  from the shared status projection; avoid invented percentage progress.
  Distinguish working, waiting, retrying, needs-member, and offline states,
  including the last activity time and next retry when known.
  Keep it visible beside the browser preview, link to the run console, and
  show a direct sign-in or permission action when member attention is needed.
  Coordinate with the run-attention notification item above.

- 🤔 **Browser handoff and return.** Make the preview's "Show browser"
  action a clear handoff for sign-in or inspecting a stuck page, with a return
  to Cubby and visible confirmation that automation has resumed. Decide how
  manual interaction suspends commands and resumes through the existing run
  lifecycle before adding controls; preserve background operation by default.

- ⏳ **Accept captured pages beside their results.** Shared Run records now
  present a bounded, newest-first capture filmstrip beside source-bound accepted
  Product facts, capture time and live source links. Retained screenshots and PDF
  originals use authenticated, checksum-verified delivery; native originals stay
  in memory. Synthetic persisted-state regressions and the focused web journey
  cover ownership, retirement, supported-fact binding and bounded navigation;
  the native client and viewer compile. Independent review, exact-head hosted
  checks, checksum-verified hosted artifacts and production deployment completed
  in [#1825](https://github.com/nickysemenza/cubby/pull/1825). Synthetic native
  viewing also passed. Installed household viewing and real-source acceptance remain open while
  live research is paused. Retained evidence remains distinct from current preview
  and does not establish research completion.

- 🟢 **Attention-first browser workspace.** Put accounts needing sign-in,
  permissions, or review ahead of routine background work, with an explicit
  reason and one action opening the exact owned window or relevant run detail.
  Keep active, waiting, and finished work easy to filter as the vendor list
  grows; show which run owns each window before switching the preview.

- 🟢 **Results as browser work lands.** Show newly imported orders and
  committed Product updates beside the preview, with covers, changed fields,
  and links to the resulting records and captured sources. Keep proposed work
  distinct from committed changes and end with a concise result summary,
  including unresolved targets and the next useful action.

- 🤔 **Recover a skipped import audit after an outdated-Mac stop.** When
  an account sync stops because the Mac app is too old and its required
  import audit also fails, the finding names the gap, but a restart audits
  only the successor's writes. Carry the predecessor's unaudited purchases
  into the successor's audit, or allow a terminal audit retry.

- 🟢 **Stop and restart runs over MCP.** [#1814](https://github.com/nickysemenza/cubby/pull/1814)
  exposes cancel, retry and restart through the existing control/dispatch path;
  `imports_read.run_status` remains the detailed read. Shared research controls
  enforce member ownership, while photo inventory retains shared-household
  control. Approve/reject and budget grants remain human-only. Independent review,
  exact-head hosted checks, merge and deployment passed; live acceptance remains
  pending while research stays paused.

- 🤔 **Measure capture model routing before changing it.** Keep the current
  evaluated routing until a controlled comparison establishes safe purchased-
  variant judgments. Jev's bounded routing does not prove exact identity;
  compare the same model version, effort, budget, sources and acceptance rules.

## Ingredients, recipes & nutrition

- 🧱 **Ingredient as the grocery hub.** Product is SKU-grade and Ingredient
  the commodity layer, but imports never fill `ingredientId`, so
  `Cauliflower` / `Organic Cauliflower, 1 Each` and three ground-beef 80/20s
  stand unconnected. In order:
  1. 🧱 Piece units resolve on the ingredient: `whole/bunch/crown/clove` come
     from USDA `portionInfo` or an ingredient-level mapping; product `each`
     prices the package and never satisfies a piece unit.
  2. 🧱 A durable ingredient-level unit mapping store, which the harvested
     equivalences report (`lib/harvest-equivalences.ts`) then writes accepted
     suggestions into.

- 🧱 **Salt amounts for “to taste” recipe lines.** Sanity-check the proposed
  1% of pot weight and define its applicability and evidence before changing
  parser or costing contracts. This estimation policy remains future work.

- 🧱 **Cookbook identity merge.** Give cookbooks durable identity plus a
  merge/repoint path to stop same-title collisions and renamed-EPUB forks. A
  recipe changes cookbook only to fix an import, so merge/repoint is the
  sanctioned path; record `cookbookId` changes in the recipe audit roster
  (`server/repo/recipe/crud.ts`) and decide whether the recipe form's cookbook
  picker (`recipe-cookbook-field.tsx`, `resolveCookbookRepoint`) stays.

- 🧱 **Portion shares alongside grams.** Accept `{share}` per portion in
  `meal_recipe.save_preparation` and derive grams at read time from the
  current `estimatedYieldGrams`, so served-by-eye portions do not go stale.

- 🤔 **Cookbook fallback evaluation.** Run the six-book answer-key corpus
  against GPT-6 Luna as the second ladder reader; compare recall, escalation
  rate, latency, and cost. Keep Gemini 2.5 Flash as first reader meanwhile.

- 🤔 **Reconsider the remaining USDA MCP App.** The USDA Picker template
  (`apps/mcp-apps/src/usda-picker.ts`) is 352,004 bytes raw / 83,655 gzip; keep
  it only while refinement and explicit selection beat a plain
  `usda_food.search`.

- ⏳ **Explicit idempotency key for `meal_recipe.add`.** Promote if a re-sent
  call duplicates a meal line. Not a natural-key index: one meal may repeat a
  recipe at different scales. First slice is an `operations/meal.server.ts`
  integration test asserting one meal holds one recipe twice with two
  independent shopping-list contributions.

- ⏳ **Exact nutrition source tracing.** Resume with upstream conversion work:
  `ingredient-parser` reports retain actual mapping identities and competing
  mappings; Cubby exposes Product/USDA/manual provenance through nutrient
  cells and nested recipes from the same computation, never inferred from
  matching values.

- ⏳ **Split compound ingredient lines.** Blocked upstream: `parse_ingredient`
  is singular and keeps "Salt and pepper" whole. Scope when unblocked: 14
  ingredients over 212 rows in 204 recipes, all with empty `amounts` (the
  discriminator). Choose split targets from `rawLine`; route writes through
  `handleSectionUpdates` sending each section's complete array; repoint the
  existing row to the first child. MCP cannot drive it (no line ids).

- ⏳ **Portion solver.** Promote if agent-side amount iteration stays painful;
  solve component weights against macro constraints in one call.

- ⏳ **Aggregate range materiality.** Promote if always-on cost/calorie/weight
  ranges create visible noise; collapse only immaterial aggregate spreads.

- 🔭 **Recipe scaling extensions.** Pan-size targets, interactive parse
  clarification, and baker's-percentage comparison without a global density
  table.

---

## Inventory, products & locations

---

## Tasks, projects & garden

- 🔭 **Grow-to-table loop.** Beds and plantings, harvests received into pantry
  inventory, and what the yard can supply this week.

- 🔭 **Seasonal garden planning and photo comparison.** Build past one-time
  `garden-plan-import` toward revising a standing plan season over season,
  comparing dated bed photos with AI, and explaining keep-versus-replace
  recommendations. Planting windows alone do not establish harvest forecasts.

---

## Native app

- 🤔 **Cluster and reproduce the native app-hang corpus before changing
  code.** Collect sanitized release, duration, foreground state, and top
  symbolicated main-thread frames per Sentry family; group by shared frames.
  Reproduce each in a Release build without LLDB (Time Profiler or System
  Trace) and make one repair per demonstrated root cause.

- 🤔 **Swift 6.4 / OS 27 readiness pass.** Before a toolchain or floor change,
  audit state initialization, concurrency, availability, and resizing against
  the actual SDK with focused behavior tests. Preserve the OS 26 path until a
  floor bump is chosen. Owners: `apps/apple/project.yml`, `App`, `CubbyKit`.

- 🤔 **Live Activities for server runs started on this device.** Record the
  initiating install separately from `ActivityRun.executors`, then send
  ActivityKit push updates so the phone shows progress while suspended. Keep
  the local-work Live Activity feed separate.

- ⏳ **Native workflow parity with web.** Promote when a recurring household
  task still needs the web. Coverage is declared once in
  `packages/schemas/src/native-coverage.ts` with a shrink-only unsupported
  ceiling per kind. Every control, list cell, detail renderer and hero action
  is native. Remaining gaps: two Run detail slots (the live and stopped
  agent conversation, which stream over the coordinator's own protocol; see the next
  item) and the few web-only parts listed under "Web-only parts inside the
  implemented native slots". Add editor focus order or
  comprehensive sheet lifecycle only on demonstrated friction. Owners:
  `apps/apple/App/Shared`, generated `EntityCatalog`.

- ⏳ **Native agent conversation streaming.** The live and stopped agent slots
  (`run.import-agent-live`, `run.import-agent-stopped`) stay web-only on
  purpose: the conversation is the coordinator's SSE stream plus prompt and abort over
  `/api/import/runs/{id}/agent/*` (`apps/web/src/routes/api/import/`), not a
  Cubby operation, so nothing in the OpenAPI client reaches it. Native needs an
  agent client in CubbyKit (authenticated SSE read, prompt POST, the abort that
  cancels the run and its browser commands), reconnect with resume after a
  suspended or dropped connection, and a transcript model that folds stream
  events into the durable timeline (which native already draws from
  `run.import-timeline`). Promote when a household member needs to prompt or
  steer a running import from the phone instead of waiting for it to pause on
  web, then lower `NATIVE_UNSUPPORTED_CEILING.detailSlot` to zero.

- ⏳ **Structured-value editor follow-ups.** Web and native edit every
  `structured-field` (recipe `sections`/`meta`/`yield`, meal `recipes` on
  create, account `identity`/`cardNumbers`, vendor `agentHints`, expense and
  transfer `sourceClaims`) with one generic editor over the generated
  `valueSchema`, each with a vector from a real server read. Left: validate on
  a device, show the ingredient or recipe name (not its shortcode) on an
  existing section line, title array rows from their content, the
  redundant-tag highlight web draws on a Tags chip, and retire the web
  `ProductUnitMappingsField`/`ProductExternalIdsField`/`SourceAliasesField`/
  `SourceRefsField` and the recipe form's meta/yield inputs in favour of the
  generic `StructuredValueField` (it already reads the same `valueSchema`).

- ⏳ **Native recipe Share extension.** An iOS and macOS share-sheet extension
  that sends a shared recipe URL to the existing server recipe import, reading
  the session token from a Keychain access group shared with the app. Promote
  when sharing recipes from the phone is wanted. Retiring the web manifest
  dropped `share_target` from installed Chromium/Android PWAs only; iOS Safari
  never supported Web Share Target, so nothing iOS-facing was lost.

- ⏳ **Core native inventory experience.** Promote when everyday use exposes a
  specific bottleneck: location-first browsing, stock comparison,
  capture/recount, photo completion. Owners: `App/Shared/Browse`, `Capture`,
  `Audit`; see [native design](../apps/apple/DESIGN.md).

- ⏳ **Generated native list/detail parity.** Stay on generated `EntityCatalog`
  and OpenAPI; revisit shared Rust only for a rule those surfaces cannot
  express. Add collapsed-section parity only for a manifest-supported consumer.

- ⏳ **Native numeric entry and units.** Promote only when a native amount
  workflow shows decimal fields are insufficient; define locale-aware parsing
  and the unit contract first.

- ⏳ **Native system-surface expansion.** One surface at a time once a
  workflow names it: Quick Look, typed drag/drop, App Intents, widgets,
  extensions, voice, timers. Keep confirmed writes and existing contracts.

- ⏳ **On-device Apple Intelligence.** Promote when devices and a measured
  capture friction justify one draft-assistance workflow; evaluate on
  fixtures and confirm before writes. Owners: `App/Shared/Identify`, `Photo`,
  `Intents`.

- ⏳ **Offline native writes and multiwindow.** Promote only when disconnected
  use or concurrent windows block a workflow; needs a write/retry/conflict
  model and window ownership rules.

- ⏳ **Web-only parts inside the implemented native slots.** What is left
  after the report commands: the recipe flow's "map" layout (a graph drawing);
  non-recipe foods and moving a portion to another meal (leftovers) in a meal's
  composition; the web cookbook reprocess progress bar (native runs the same
  workflow to its end and shows the summary). Promote one when a household
  task needs it on the phone.

- ⏳ **Expose the rest of recipebridge via cubby-ffi.** Scaling (`scale_amount`,
  every scale-factor anchor including total weight, scaled counts) ships with
  native cook mode. Conversion,
  needs, costing, and nutrition stay web-only until a native screen prices a
  meal or shows a costed recipe.

---

## Web UI

- 🟢 **Show unmatched edit issues in the dialog banner.** A validation issue
  whose path has no rendered control (e.g. `externalIds.0.isPrimary`) is set on
  the form but never shown: `entityEditBannerIssues`
  (`entity-edit-dialog-content.tsx`) excludes every field-scoped issue, so Save
  fails silently. Surface issues no registered control can display.
- 🤔 **All-entities record interaction parity.** Reuse standard row inspection,
  selection, clipboard behavior, and actions in the Records tab. Decide which
  actions are eligible for mixed entity types before enabling batch work;
  build on `EntityRecordsTab` and shared RTable behavior.

- 🤔 **Make narrow web layouts device agnostic.** The compact shell still uses
  phone-style tabs and overlays. Design one compact navigation and overlay
  pattern for narrow widths on desktop and iPhone, keyed on width, keeping
  safe-area, keyboard, and touch behavior where exposed; update the design
  language and responsive checks.

- 🤔 **Phone hit areas as pseudo-elements, app-wide.** Button's
  `mobileSize: "touch"` grows icon controls to 44px layout boxes, wrapping
  dense rows. The detail ledger keeps the target as an `::after` (the
  `checkbox.tsx` pattern). Decide whether `touch` itself becomes a
  pseudo-element target.

- 🤔 **List-route SSR payloads are large.** `/projects` 826 KB, `/locations`
  655 KB, `/recipes` 579 KB of HTML. Find what the list loader and slot views
  dehydrate before trimming or deferring.

- 🤔 **Eyeball `/graph` after the canonical-owner change.** #1067 made the
  foreign-key side own a shared path, so `product → inventory` now reads
  `inventory → product`; inspect the Relationships tab and `/graph` for
  relations declared on both sides.

- 🤔 **Server-backed table intelligence.** Extend exact facet counts and
  aggregate summaries from Expenses to one justified server-paginated surface
  at a time; never analyze a partial client page as the population.

- ⏳ **Named web fidelity losses from the manifest-rendering pass.** Promote
  if a workflow misses one: the interactive subtask checklist, project's
  tasks list/board toggle, purchase per-line quantity/unit-cost columns,
  location's merged sub-locations+items surface, product's stock-stats row.

- ⏳ **Timeline notes carry links and product `usedOnProjects`.** Promote when
  "N products omitted" needs to be clickable again or a lifecycle row needs a
  project link; `EntityTimelineOut.notes[]` are plain strings.

- ⏳ **Push change feed for post-mutation refresh.** Promote only when a
  derived value users wait on reliably lands after the +5 s / +30 s deferred
  refetch (`lib/deferred-invalidation.ts`). Design: a Durable Object change
  feed over WebSocket Hibernation; rejected for now as ~300–400 lines of
  infrastructure for a single-household tool.

- ⏳ **Selective SSR expansion.** Promote another route family only if the
  product-detail pilot wins a cold-cache comparison without INP, CLS, or
  Worker-error regressions.

- ⏳ **Selection-control consolidation.** Promote a selector family when
  visual or keyboard inconsistency becomes painful.

- ⏳ **Measured table-virtualizer investigation.** Revisit direct-DOM-write
  options only during a measured investigation (`directDomUpdates` no longer
  exists in the installed `@tanstack/react-virtual`).

- ⏳ **Residual N+1 repair** when a fresh trace finds concrete fan-out;
  **Sentry lazy initialization** if a fresh treemap shows Sentry on the
  critical path.

---

## Entity platform & data model

- 🧱 **Audit for deletion and consolidation after the research rewrite.** Review
  the whole codebase, including database tables, import/browser execution, review
  surfaces, and tests. Identify unused functionality, duplicate services and
  policies, redundant persisted state, and code that can move into shared
  declarations or maintained Markdown skills. The model should own adaptive
  investigation and semantic interpretation; justify each code layer by evidence
  retention, recovery/replay, ownership, or safe domain writes. Prefer existing
  Expense/domain services over a second accounting framework. Propose concrete
  deletions and table consolidation with preserved invariants and data-transforming
  migrations; measure the resulting code and schema reduction. The initial
  [audit and concrete migration proposal](plans/research-simplification.md) is
  recorded; implementation and historical/in-flight readback remain open.

- 🤔 **Product Category feature expectations.** Decide whether Food _expects_
  an ingredient and Books an ISBN (both `unknown` today, so no data-quality
  gap) and whether a Food Product may carry an ISBN outright rather than only
  by precedence; and whether seed/plant categories should expect
  `growsPlantId` (no feature or rule exists yet). Each answer is one policy
  value in the ProductCategory manifest declaration.
  Inherited classifications (Vendor → Purchase → Expense) resolve through
  their existing effective-value SQL before a refusal applies.

- 🤔 **Declarative "many, clamped to one" cardinality.** Image provenance
  chose a many-row `ImageSighting` child plus derived `one` Image fields over
  array relations with a runtime clamp. Revisit only when a second entity needs
  multi-evidence provenance; extend relation `provenance.sources[]` first.

- 🤔 **Dependent batch program.** A bounded program of named operations whose
  results feed later inputs: limits, failure propagation, ordered partial
  outcomes, retries preserving completed writes, explicit continuation.

- 🤔 **MCP staged-file storage.** Before sharing a local upload beyond its
  signed grant, define no-copy activation, grant replay, activation fencing,
  delete-before-expiry for a recreated orphan, and evidence ownership, on the
  `EntityAttachment` model in ADR 0006.

- 🤔 **Host-provided MCP file references.** Adapt client-owned file handles
  and download URLs through capability-specific input metadata and the
  validated URL-fetch path; downloadable URLs remain the fallback.

- ⏳ **Generic HTTP `resources.<entity>.batch` route.** Promote if a 5k-asset
  library makes one-row-per-request writes measurably slow; mirror
  `entity.commands`'s independent-item semantics.

- ⏳ **Budget-aware MCP pagination.** Promote when a real tool result hits an
  output limit: stable keyset cursors, byte and result limits, and a
  continuation preserving filters, sort, and budget.

- ⏳ **Durable MCP transfer telemetry.** Persist call duration, response
  bytes, and per-item outcomes when repeated measurements justify it.

- ⏳ **Entity relation runtime dispatch.** Promote when attach/detach
  genericization resumes; generate dispatch only for declared runtime ports.

- ⏳ **`stored` descriptor sweep per repository.** Promote when a hand-built
  list drifts from its declared columns; convert per repository
  (`product/crud.ts`, `purchase.ts`) and verify with the real-query matrix.

- ⏳ **RunFinding as a manifest entity.** Promote once a second parent needs
  its list. It is the one run child with its own lifecycle and a Purchase
  relation; costs a prefix, a backfill, an `AuditEntityKind`, and the same
  delete/resolve disposition decision as StatementRow.

- ⏳ **StatementRow and StatementImport as manifest entities.** Promote once
  the `supersededByRowId` disposition (block, detach, or cascade) is decided.
  Unblocks auditing: all three statement-row mutation paths write no audit
  trail. Backfill shortcodes in batches with an in-memory set of existing
  codes (`generateUniqueShortcode` is per-candidate SELECT).

- ⏳ **Put `deleteStatementRows` on policy-driven removal.** The last
  hand-written cascade (`repo/statement-row.ts`); waits on the item above. The
  image hard delete stays on `IMAGE_HARD_DELETE` on purpose
  (`repo/removal/core.unit.test.ts`).

---

## Classification in the manifest

Shipped: option meanings and `suggest.rules` live on field declarations and
the suggestion registry is generated; same-record and relation classification
policies (Expense line kind and basis, Location furniture, GardenEntry kind,
ProductCategory project-tool and Planting-source relations) drive writes,
generated CHECKs, data quality, the editor and Suggestion targets; the
Suggestion sweep, list field pills and `eval:decisions` exist; review happens
in entity lists without a separate page
([entities](entities.md#classification-field-policies)).

- 🤔 **Declare effective-value inheritance chains.** "Expense category =
  override → vendor food context → product mapping (category ancestors) →
  Purchase default → Vendor default" lives in hand SQL
  (`repo/expense-category-resolution.ts`), as do project inheritance and
  receipt-evidence expectation (Purchase override → Vendor → SpendingCategory
  `evidenceExpectation`, `repo/purchase-evidence-policy.ts`). Declare each
  chain and generate the resolution SQL, the "inherited from" explanation,
  and the set of Expenses a change can reach — the reach scope the reviewed
  classification preview hand-writes. Generated SQL must match hand-tuned
  performance; #1712's preview equivalence and scale tests are the guard.
  Decide the declaration shape first.
- 🟢 **Burn down raw enum literals in SQL.** `cubby/no-raw-enum-literal-in-sql`
  holds a shrink-only per-file baseline
  (`tools/oxlint/cubby/no-raw-enum-literal-in-sql-baseline.json`). Replace
  literals with the shared value constants file by file, lowering each count;
  check whether generic values (`other`, `unknown`) cause false positives
  worth excluding.
- 🟢 **Move the image backfill onto the paced batch Run.**
  `backfillImageProcessing` keeps its own settings-row pause and progress;
  move it onto `runs/paced-batch.ts` beside the Suggestion sweep.
- 🤔 **Re-weight the decision trial from paired data.** Normal decision
  traffic stays 50/50 Jev/Clef (`CLEF_TRAFFIC_SHARE`). Once sweeps have
  produced paired rows and Misses, run `eval:decisions` and retier on its
  per-field results.

Per-row household policies (SpendingCategory `productExpectation`) stay
columns; algorithms (allocation, reconciliation, fingerprints) stay code and
consume the declarations.

---

## AI & search

- 🤔 **Assess Agents SDK capabilities after the purchase rewrite.** Compare
  Cubby's existing plumbing with the [SDK feature table](https://github.com/cloudflare/agents#features),
  especially state/RPC synchronization, scheduling, child-agent timelines, and
  bounded Code Mode research composition. Generate typed composition methods
  from the existing research contracts and reuse their domain services; keep
  lifecycle/browser waits and original-media delivery explicit. Preserve Pi's
  recovery ownership, task-scoped evidence, per-call admission, and replay
  fences. Adopt capabilities where they remove duplicate code or demonstrate
  better research behavior. Evaluate a persistent Computer workspace only for
  a concrete document-processing need, including source disposal and production
  readiness. This follow-up does not expand the current rewrite or the separately
  owned MCP enrichment workstream. See the current
  [feature-by-feature assessment](plans/research-simplification.md#sdk-feature-assessment);
  experiments and measured code removal remain open.

- 🟢 **Show estimated API spend avoided by subscription inference.** Retain
  each ChatGPT-plan call's catalog-priced API equivalent alongside its zero
  incremental API charge, then aggregate it through the shared AI usage and
  Run reports. Label the amount as estimated API spend avoided; preserve
  unknown prices as `null`, count cache/replay correctly, and keep subscription
  fees separate. Do not infer savings from missing usage or add a separate
  accounting workbench.

- 🟢 **Use Claude subscriber API credits through AI Gateway BYOK.** Link an
  eligible Max or Team plan to a Claude Console organization and claim its
  [included API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).
  Store that organization's Anthropic API key in Cloudflare AI Gateway under
  the `default` [BYOK alias](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/),
  which precedes [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
  when a request supplies no provider key. Use the Console API key, not Claude
  login credentials. Verify the route and spend limit, record credit-funded
  usage separately from paid charges, and prevent unintended paid fallback or
  auto-reload when the expiring monthly credits run out. Reuse shared transport
  and usage reporting; credits are bounded, not unlimited free API access.

- 🤔 **One pricing source for the upstream cookbook pipeline.** Cubby usage
  pricing uses `models.dev` through `packages/shared/src/ai/pricing.ts`, but
  ingredient-parser's `cookbook` crate still builds its own model-price table
  (`cookbook/src/models.rs`, `cost.rs`, `Cargo.toml`). Decide how that pipeline
  receives catalog prices, then remove `llm_models_spider` upstream and update
  Cubby's pin. Preserve extraction estimates and token-cost accounting,
  including unknown prices as `null`; do not reintroduce a local fallback table.

- 🤔 **Deferred MCP agent capabilities.** Real agent work no MCP tool exposes
  yet. Each operation declares `mcp: { omit: "deferred_capability" }` and
  `pnpm generate` requires it to be named here
  ([MCP exposure](agents/mcp.md#exposure)). Decide per group whether and how
  to expose it, then drop the group when it ships:
  - Order mail: `vendor.orderMail`, `vendor.importOrderMail`,
    `vendor.importSelectedOrderMail`.
  - Targeted runs and their evidence:
    `purchaseImport.initiateRunEvidenceUpload`.
  - Inventory receiving: `inventory.receiveExpense`,
    `inventory.receivingContext`, `problems.resolveArrivedFindings`.
  - Discarding units: `inventory.bulkDiscard`, `product.discard`.
  - Finance booking and corrections: `financialTransaction.previewBooking`,
    `financialTransaction.commitBooking`,
    `financialTransaction.previewBookingCorrection`,
    `financialTransaction.commitBookingCorrection`,
    `purchase.settlementCandidates`.
  - Statement CSV import: `statementRow.previewCsv`, `statementRow.commitCsv`.
  - Expense pivots: `expense.analyze`.
  - Product merge preview: `product.mergePreview`.
  - Meals: log a food without a recipe (`meal.saveFood`, `meal.removeFood`);
    copy plans (`meal.duplicate`, `meal.copyRange`).
  - Collection membership: `collection.set`, `collection.create`.
  - ISBN create: `product.findOrCreateByCode`.
  - Derived-field explanations: `fieldExplanation.explain`.

- 🤔 **Trial `@cf/baai/bge-base-en-v1.5` via AI Gateway alongside OpenAI.**
  Compare recall against the OpenAI adapter with this eval set:
  `"plastic tarp"` → `blue plastic tarp` (product); `"drop cloth"` →
  `plastic drop cloth` (product); `"where are tarps"` → `tarps cloths
  blankets` (location); `"packout"` → `packout organizer` (product);
  `"parchment"` → `parchment paper` (product); `"tarpaulin"` → `blue plastic
  tarp` (product); `"cling film"` → `plastic wrap` (product); `"adjustable
  spanner"` → `adjustable wrench` (product); `"wet dry vac"` → `shop vacuum`
  (product); `"painters cover"` → `painters drop cloth` (product). Trap: rows
  are keyed on `(provider, model, dimensions)`, so `findRelatedSearchCandidates`
  must resolve the active `SemanticEmbeddingConfig` before embedding the query.

- ⏳ **Trace the web Worker's AI calls into Sentry's Agents view.** Sentry
  wraps only `env.AI.run()`, not the `env.AI.gateway("cubby").run()` transport,
  and pi-ai calls use Cubby's shared gateway transport. Add `gen_ai.chat`
  spans at that transport when a web AI feature needs per-call debugging
  the Gateway cannot answer.

- 🔭 **Standing household agents.** A registrar for records, quartermaster for
  consumable shortfalls, and foreman for stale or blocked projects, approving
  durable writes.

- 🔭 **Ambient capture.** Voice memos, forwarded email, shared photos, and NFC
  entry points.

- 🔭 **Cubby to Home Assistant** (maintenance due, weekend work, tonight's
  meal for display and voice) and **Home Assistant to Cubby** (runtime,
  energy, fault, and weather signals into maintenance, evidence, and tasks).

---

## Dev tooling, tests & CI

The developer loop now defaults to focused headless + simulator smoke, retains
extended domain lanes by name, uses deterministic stored-outcome read-back with
small Tester Army navigation, and reuses verified native builds. Low-signal
source/copy/declaration tests are removed with a deletion ledger. The shared T3
device launcher is supported for finite simulator journeys.

Completed in the developer-loop change: separate app/Kit package lockfiles,
shortcode-aware Tester Army replay keys, verified abandoned-container recovery,
and Docker-backed persistent development. See [implementation and test deletion
evidence](dev-tooling-evidence.md).

- 🤔 **Measure post-change routing speed and quality.** The
  [2026-10-08 metadata recheck](dev-tooling-evidence.md#routing-measurement)
  records delegation and token shares, but mostly predates the routing rule.
  Repeat after a full post-change window using the same accounting and explicit
  latency/quality evidence; do not infer improvement from token shares alone.

- 🤔 **Capture exact runtime error shapes before broadening suppression.**
  Client-disconnected cancellation, missing update-result, opaque database
  failure, and pathological LIKE/GLOB reports need sanitized
  name/message/stack/route evidence and an event-shaped regression test before
  changing filters; never hide unrelated transport or query errors.

Fixture-backed generic list previews and optional warm HMR Playwright validation
are implemented. See [local development](local-development.md#fixture-previews-and-warm-hmr-validation).

- ⏳ **Natural CI evidence.** Revisit sharding only when exact-head runs show
  a repeatable tail imbalance; no duration databases or custom sequencers.

---

## Infra & deploy

- 🤔 **Maintenance mode.** The `MAINTENANCE_MODE` Worker secret makes the web
  Worker answer 503 and skips the cron (`server/maintenance.ts`); purchase
  coordinator callbacks and tool effects now defer/refuse before DB/model
  access, and browser brokers close without acknowledging unprocessed results.
  Queues are paused by hand. Remaining:
  status in a Durable Object checked per request (503
  page except a new health route and the switch), by every queue consumer
  (`background-tasks/consume.ts`, `telemetry-queue.ts`, the purchase-agent
  consumer) and each Workflow-backed Run step (`server/workflow-runs/`), and by the agent's purchase-import run before each tool call (via a
  Run service); toggle from Settings and MCP. Decide first how
  consumers hold messages: a normally returning handler acks them, and
  `retry()` spends `max_retries: 3` with no dead-letter queue, so either call
  the Queues pause-delivery API from the toggle or retry with long delays.

- 🤔 **Move mechanical backfills onto existing Workflow-backed Runs.**
  Scheduled Gmail discovery uses a Workflow; vendor mail-search's former
  production starter has been removed, while its Workflow and synthetic tests
  remain. Audit that orphaned chain before preserving it as precedent (see the
  [deletion proposal](plans/research-simplification.md)). Long, page-oriented
  mechanical backfills are the next fit: give each a
  Run whose progress is the cursor and reuse `server/workflow-runs/`. Evaluated
  and kept as they are: `cubby-background` tasks (single, freshness-gated and
  idempotent, so a queue fits), image processing (a device-companion
  WebSocket Durable Object with leases), the purchase agent (Agents SDK
  Durable Object with pi-durable state), and telemetry (a batched queue).
  Device-local work (library scan, classification sweep, sighting backfill)
  can post into `runProjection` as a transport addition.

- ⏳ **Failed Runs on the Problems page.** Routine scheduled Runs are hidden
  by default, so a failed scheduled pass is visible only in the Runs list.
  Promote if one goes unnoticed.

- ⏳ **TanStack Start observability.** Remove Cubby's wrapper when Start
  supplies named request/result/error events and exposes the dispatched
  operation id to a request hook (checked 2026-09-16: not yet).
  <https://tanstack.com/start/latest/docs/framework/react/guide/observability>

- 🟢 **Resolve relation-filter shortcodes inside the list query.** A filter
  such as `growsPlantId` awaits a shortcode→id lookup before the page, count,
  and sums start (`repo/shortcode-resolver.ts`, `buildProductWhere`). Use a
  live-row subquery instead, keeping unknown and deleted codes matching
  nothing. The first query on a request also absorbs connection setup, so
  measure the gain rather than assuming the lookup's full duration.

- 🤔 **Share product kit and category work across list queries.** One product
  page walks the kit graph four times (cost, valuation, sums, quality) and the
  category ancestors per row. Collapse those only where EXPLAIN on production
  data shows a win; keep unrounded valuation and signed expense sums, and do
  not merge everything into one relational query (its memory cost is
  documented in `repo/product/crud.ts`).

- 🤔 **Summary `entity_read.get` without the detail read.** A summary get
  still runs the complete detail read (USDA, quality, ledger, breadcrumbs)
  before projecting to identity. Route it through `listFields` with an `ids`
  filter only after confirming each kind's list visibility matches `get`
  (default filters can hide rows a `get` returns).

- ⏳ **Production query-cost repair.** Promote the specific offender a fresh
  production trace confirms; remeasure before restructuring counters.

- 🟢 **Pre-render the docs Mermaid diagrams.** Three diagrams pull ~108 client
  chunks (~4.9 MB raw, ~1.4 MB gzip, including the only >500 kB chunk, `elk`)
  through `app/docs/_components/MermaidDiagram.tsx`. Render them to SVG in
  `pnpm generate` (with a drift check) and delete the runtime dependency. Pick a
  renderer that runs without a browser first.

- 🤔 **Trim duplicate and unused Worker dependencies (~0.4 MB gzip).**
  `agents` pins `@modelcontextprotocol/server`/`client` at exactly 2.0.0 next
  to the app's 2.2.0 (~210 kB duplicate; dedupe via override if the agent's API
  still matches); better-auth's kysely adapter bundles introspectors for every
  dialect (~211 kB); `agents`' email feature pulls `mimetext` (~156 kB, stub it
  like `cfZodLocalesStub`); `vendor-identity` ships the full `tldts` suffix list
  (~259 kB). Check each with a `dist/server` size diff.

---

## Compatibility removal

[Breaking changes](../AGENTS.md#breaking-changes) is the rule; these are the
compatibility paths still live. Printed `P-`/`L-` QR labels and stored agent
transcript tool names (`app/purchases/agent-tool-names.ts`) are physical or
historical records and stay readable. `oauth_client.requirePKCE` and
`referenceId` are not legacy: Better Auth 1.7 still declares and reads them.

- 🤔 **Require statement-row positions.** `repo/statement-row.ts` keeps the v1
  content-hash path for callers without file positions, and that path is what
  dedupes overlapping full-history exports today. Requiring positions needs a
  cross-file occurrence rule first. A prototype on branch
  `compat/statement-row-positions` (`statement-row-occurrence.ts`) maps the
  k-th incoming row of a legacy hash to the k-th live row from another export.
  Review reproduced three gaps it must close: concurrent overlapping commits
  create one row but two transactions (hold the source lock across the whole
  commit and revalidate settlement refs inside it); chunked record (500) and
  paged preview (200) restart the occurrence count, losing identical
  occurrences (count across the whole file); attach re-resolves each row
  singly, so replaying two settled identical charges fails (pass the resolved
  occurrence ref through). Keep `statementRowExternalId` frozen: stored
  `settlement_ref` values derive from it.
- 🧱 **Re-extract flat-array cookbooks, then delete their fallback.** A few
  cookbooks still store the retired flat-array extraction
  (`repo/cookbook.ts`, `isLegacyCookbookRawJson`); the list shows a
  needs-reextract badge. Re-extract them from their EPUBs (not stored), then
  delete the fallback.

---

## Probably not anytime soon

Parked on purpose: wanted in principle, but nothing in current household use
pulls them forward. Promote only with a concrete trigger; group by domain so
related active work can find its deferred follow-ups.

### Purchases, finance & household ledger

- **Extend source-neutral statement import beyond CSV.** PDF and OFX with
  source text, date semantics, and account evidence preserved; AI-proposed
  mappings behind a visible preview; never infer kind from the amount's sign.

- **Bulk expense attribution and contribution-gap links.** Reuse the existing
  ledger editors and generic bulk path when shared-cost tagging or finding
  unresolved attribution becomes repetitive. Keep per-role replacement and
  one shared gap definition. Remaining slices and importer guidance:
  [ledger attribution follow-ups](plans/household-ledger-attribution-followups.md).

- **Person-to-person repayment discovery.** Promote once Ledger Transfers
  entered by hand become a chore. Sources: imported statement rows for payment
  apps never promoted to Financial Transactions, and Gmail "paid you" mail.
  Review-only; never resolve a counterparty automatically. Context:
  `docs/plans/household-ledger-attribution-followups.md`.

- **Project default beneficiaries.** Promote if shared-cost projects become
  frequent: explicit, then project default, then household, following
  `expense-inheritance.ts`. Needs schema and allocation-SQL changes.

- **Household finance analytics and cash-flow projection.** Category
  breakdowns, a funder-to-category Sankey, transfer-pair acceptance, and Phase 2
  projection remain deferred until household planning needs these views.
  Preserve the proposed contracts in
  [household finance synthesis](plans/household-finance-synthesis.md); net worth
  and retirement need a separate product/tenet decision before a time-series
  model is introduced.

- **Household balance sheet.** Promote when replacement planning, insurance,
  or cost-basis exports are actually needed. Generalize location valuation
  into replacement forecasts and cost-per-project analysis.

- **`imports_read.vendor_coverage` per account.** Promote when two members
  hold accounts at the same vendor.

- **`PurchaseLine` SKU annotation.** Promote when store SKU, quantity, or
  unit-price detail is genuinely wanted; `Expense` stays financial truth.

- **Purchase evidence references** when Gmail, Drive, or portal evidence
  must be queried beyond notes and attachments; **purchase
  replacement/exchange relations** when they need navigation, not notes.

- **Per-edge breakdown for purchase merges.** Promote if `merge_entity`'s
  empty `moved` array on purchase is noticed; `foldChargeInto` does not count
  moved expenses and documents.

- **Multi-product Expense links.** Promote when one Expense needs several
  Products and `splitExpense` cannot truthfully split the money.

- **Returned-unit price advisory.** Promote when another stocked Product
  has a materially inflated derived price or returns become structurally
  distinguishable from sales; stay advisory.

- **Services-with-product advisory.** Promote when the first live row
  appears or an import repeatedly creates one; advisory, not a constraint.

- **Estimated-allocation analytics caveat.** Promote when
  materials-versus-labor analytics inform a real decision; disclose the
  allocation-basis portion without excluding it from total spend.

- **Evaluate trade affinity in expense project suggestions.** Once the
  `expense.projectId` roster's per-project trade tallies
  (`server/ai/field-suggest/registry.ts`) have served real suggestions, compare
  accept/override rates on `/ai-usage` and drop the tallies if they do not help.

- **Shared-expense export re-import dedupe.** A Splitwise-style CSV has no
  row id, so provider ids derive from date + description + amount; promote if
  a re-export with edited descriptions is imported again.

### Inventory, products & locations

- **Persisted Collections and operational dashboard.** Smart starters
  evaluate manufacturer, tags, Location names, and historical Trades with
  editable OR rules. Promote when Collection tags need metadata, rename-safe
  identity, durable rules, or richer rules; migrate `collection:*` tags into
  durable records, and evaluate smart membership from a saved Product filter at
  read time. Extend the Trade predicate with "primary inferred Trade matches".

- **Repeat-purchase ranking.** Promote when enough Products have genuine
  repeated acquisitions.

- **Before-drywall spatial capture.** Promote immediately when construction
  is scheduled; define the smallest room/wall-indexed photo packet before
  walls close.

- **Digital twin and spatial memory.** Promote when a specific building
  knowledge retrieval need exceeds Location notes and attachments. Attach
  shutoffs, breaker maps, paint, and hidden utilities to the location tree.

- **`location.tags` redundant-token pruning.** Locations hold only
  `collection:*` tags today.

### Ingredients, recipes & nutrition

- **Durable shopping list.** Server-backed manual items (milk, paper towels)
  and checked state across date ranges and devices, independent of inventory.
  Blocks sending meal-suggestion shortfalls to the list and shopping pack
  rounding.

- **Grocery cost basis.** Allow `productId` on `discount` rows (Whole Foods
  promos, Buy-Again are per line) and let `productQuantity` carry `{value,
  unit}` for measured lines (`0.5 lb @ $4/lb`), folding both into derived cost
  basis without changing `SUM(Expense.cost)`. Promote when per-serving or
  per-unit cost numbers are actually used.

- **Recurring meals, meal templates, and meal nutrition goals.** Each its own
  slice; goals would compare planned nutrition against explicit targets.

### Tasks, projects & garden

- **Project materials and shortfalls.** A project-material edge with
  quantity, free-text unit, optional Product, and durable/consumable semantics
  (see `Product.kind`); derive have/need/buy through the availability engine
  without reservations or automatic decrement. Promote when a concrete
  project needs a have/need/buy worklist.

- **House timeline.** Promote when project journals or before/after retrieval
  need a chronological view beyond current timelines. Generalize `GardenEntry`
  into dated Location, Planting, and Project journal entries on
  `resources.<entity>.timeline`, then project milestones, photo comparisons,
  and an annual view.

- **Heirloom outputs.** Promote when preparing an actual handoff or archive:
  a future-owner house manual, project yearbooks, and a durable export format.

- **Project locations as Locations.** `Project.locations` holds a few
  free-text street addresses, mostly former residences.

- **Recurring maintenance tasks.** Every-N-weeks/months; completing an
  instance creates the next through one idempotent transactional rule.

- **Hierarchical Project/Task parent pickers.** Rosters are shallow; revisit
  on deep nesting.

### Native app

- **Accept recipe links from the iOS Share Sheet.**

### Web UI

- **Saved user-created views.** Named filter/sort sets via the versioned
  external-state pattern, beside manifest `presentation.list.views`.

---

## Dormant schema — revisit

Built but barely used. Each stays until someone decides to use or remove it;
counts are dated observations from the 2026-09 consolidation, not current
usage measurements or proof of obsolescence. (The contribution ledger left
this list: attribution prefill now reads it.)

- **Historical Run machinery.** Audit `RunOrderCandidate` and legacy approval /
  control storage only after checking current readers, historical state and
  in-flight recovery. `RunEvidence`, `ImportHunt`, `ImportPreparedOrder` and
  `ImportPreparedLine` are active contracts, not dormant tables. Recheck against
  [import and resume orders](#import-and-resume-orders-reliably) before deciding
  whether to use or remove these tables.
- **Review queues.** `SuggestionDismissal`, `ProductMatchCandidate`,
  `ImageDescriptionCorrection`, `OrderMailCandidateDecision`,
  `MerchantVendorRule` (historical counts: all 0). `MailboxCursor` is active in
  Gmail pagination/replay and must be preserved. Recheck against Product match
  recall, collision review, and [purchase corrections](#review-and-apply-corrections);
  an empty queue alone does not establish that its workflow is unnecessary.
- **Always-null columns.** `Plant.daysFrom*` and `Plant.breeding`,
  `Planting.outcome`, `Vendor.returnWindowDays` and `Vendor.orderEvidence`,
  `Run.historyCursorUrl`, `Task.sortOrder`,
  `Meal.sortOrder`, `Wish.acquiredAt`, `Device.productId`, `Cookbook.report`.
  Image `captureDeviceLabel`, `capturePlaceName`, and
  `capturedAtOffsetMinutes` fill once the library path sends them (Images &
  photos).

---

## Operational passes

- **Project existing images into search.** Never run: 27 of 6,292 Images have
  a `SearchDocument`. Runs entirely server-side (projection, then queued
  embeddings through AI Gateway). Best after automatic description is on, so
  documents carry description text; call `maintenance.backfillImageSearch`
  until it reports `stopped: "complete"`.

- **Finish image provenance rollout on existing photos.** 266 of 6,292 Images
  carry provenance. Run `classifyImageProvenance` in dry-run mode, review,
  apply the accepted sweep, then run `backfillImageMetadata`. Confirm each
  native install's Automatic work choice.

- **Fill ingredient density gaps.** Use the missing-weight list to add Product
  `UnitMapping` data as ingredients need it.

- **Fill missing acquisition quantities.** Work through Expenses → Missing
  quantities and record known counts on Product-linked acquisition rows.

- **Register missing payment instruments.** Every card or bank account used
  to pay vendors belongs in Cubby as a `FinancialAccount` with aliases before
  the next statement import, or its rows can never settle.

- **Settle bare card charges.** Work from `/finance` with purchase presence
  set to none, matching existing Purchases before booking new ones
  (`finance_read.expense_match`, `finance_read.transfer_pairs`). Itemize
  lump-line orders only where a receipt is on hand.

- **Ingest a seasonal garden plan with `garden-plan-import`.**

- **Import the household wardrobe.** One member's clothes per capture session
  into a `photo_inventory` run with that member as owner; an agent proposes
  groups with `photo_run.propose_groups` and a human approves them. Then import
  the matching vendor orders and work the product match queue
  (`/recommendations/workbench?kind=product-match`). Playbook:
  [photo-inventory pilot](runbooks/photo-inventory-pilot.md).
