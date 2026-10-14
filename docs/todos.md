# Cubby — Work List

The canonical backlog, grouped by area. Items are not ranked. Each item starts
with a status marker naming its next blocker, followed by a work-type marker:

| Marker | Meaning                                                |
| ------ | ------------------------------------------------------ |
| 🟢     | Ready: decided, no schema change                       |
| 🧱     | Ready once schema or migration is planned              |
| 🤔     | Needs a decision, investigation, or evidence           |
| ⏳     | Waiting on a named trigger; promote only when it fires |
| 🔭     | Long-term direction                                    |

An unresolved decision or missing evidence outranks an eventual schema change.
Work type describes the intended outcome, independently of status:

| Marker | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| 🐛     | Bug: repair incorrect or broken existing behavior              |
| ✨     | Feature: add or extend a capability                            |
| 🛠️     | Maintenance: refactor, cleanup, performance, or infrastructure |
| 🧪     | Investigation: gather evidence, evaluate, or verify behavior   |

Use one of each, status first: `🤔 🐛` is a bug that needs investigation;
`🟢 ✨` is a feature ready to implement. Choose the type by the primary
outcome: investigating a reported defect remains 🐛; a comparison or
acceptance pass with no committed repair is 🧪. Mark independently actionable
numbered steps the same way.

**Probably not anytime soon** parks wanted-but-unpulled work and carries only
a work-type marker. **Dormant schema** lists built-but-unused tables, and
**Operational passes** are household data work rather than software; those
two carry no markers.

Keep entries concise and outcome-oriented. Record only constraints that would
change selection or implementation, with a pointer to the code or focused doc
that owns the full contract. Shipped and superseded work leaves this file; git
history is the archive. Permanent product constraints live in the
[Tenets](../README.md#tenets), not in rejected-idea essays here.

---

## Images & photos

- 🟢 🛠️ **Audit legacy image orientation mismatches.** After the hash-guarded
  verification fix deploys, review existing `metadata_mismatch` rows through
  explicit verification. Normalize swapped dimensions only when the stored
  original hash, byte length and MIME agree. Preserve files, attachments,
  own-photo covers and labels; investigate remaining failures separately.

- 🟢 ✨ **Data-quality check for a missing cutout.** Wardrobe galleries prefer
  the transparent representation (`representations.transparent`), so a Product
  with photos but no cutout looks out of place. Add a Product check so "no
  cutout" joins Wardrobe's needs-attention view. Deferred from Wardrobe v1,
  which uses the existing `product_image` check and unconfirmed-owner filter;
  pair it with the next photo-import pass.

- 🤔 🧪 **Review existing duplicate research images.** New research admissions
  reuse same-byte item attachments under the Product lock and retain each source's
  support. Existing duplicate galleries and historical images without SHA-256
  need an approved preservation/cleanup plan. Preserve member photos, cover order,
  labels and genuinely different variants; do not delete household records from
  a forward-prevention fix.

- 🧱 ✨ **Full capture metadata from the Photos library.** The library match path
  (`LibraryMetadataSync` → `image.recordSightings`) already backfills
  `capturedAt` and location for every strong perceptual-hash match across the
  whole library, including photos never uploaded from that device, but sends
  `camera`, `capturedAtOffsetMinutes`, and `placeName` as nil
  (`PHAsset+LibraryAssetFacts.swift`, `LibrarySighting.swift`); the missing capture-device and place labels remain a data gap. For strong
  matches, load the asset's image data (may download the iCloud original) and:
  fill those gaps; store the raw ImageIO EXIF/TIFF/GPS dictionaries (minus
  MakerNote and binary values) in one jsonb on `ImageSighting`, since edits
  differ per library copy; and have server extraction
  (`services/image-metadata.ts`, `embeddedMetadata`) keep the same raw
  dictionaries for uploads that still carry EXIF. Nothing reads shutter,
  aperture, or ISO yet; they are kept so the bytes never need refetching.

- 🤔 ✨ **Improve photo identification recall and explain its limits.** Extend the
  retained Apple/Clef observation and unconfirmed-Product suggestion paths
  (`image-identification.service.ts`, `image-identification.ts`,
  `image-processing-panel.tsx`); the
  [design interview](plans/photo-identification.md) owns the wider use cases.
  Keep processing automatic and simple, without regions or manual tuning.

  **Next implementation brief — retrieval and coverage (steps 1–3).** Improve
  existing-Product identification when the visual category is plausible but
  narrower than the catalog identity. Deliver one automatic, bounded retrieval
  path and an honest explanation of what was searched and compared.

  Start with synthetic regressions for a wrong category, a correct Product
  outside the initial roster, truncated searches, and candidates with only the
  source image as reference. Inspect existing search/ranking helpers before
  choosing category expansion, lexical/semantic blending, deduplication and
  deterministic ordering. Preserve retrieval provenance through visual ranking
  so “not retrieved,” “no independent reference,” and “compared but rejected”
  remain distinguishable. Existing attachment context is separate from match
  confidence; it must never validate itself.

  Before implementation, decide the retained coverage/result shape, revision
  invalidation and preservation of historical observations; establish whether
  a data migration is needed rather than assuming one. Use the same coverage
  contract in the image UI and generic reports/MCP. Present bounded no-match
  and incomplete comparison separately, with diagnostic detail behind disclosure.
  Keep multi-item proposals, frontier escalation and native chooser integration
  outside this slice.

  Acceptance: the correct Product reaches retrieval despite category mismatch;
  source/revision/live-Product guards survive expansion; confirmation remains
  required for consequential changes; and the visible explanation matches the
  retained coverage. Measure retrieval recall separately from match quality on
  held-out cases, with latency/call limits explicit before any live replay.

  1. 🤔 ✨ **Retrieve across plausible categories.** Use category as a ranking
     hint rather than a hard filter; combine lexical/semantic identity evidence
     and broaden a bounded search when it misses. A flower-and-fruit catalog
     image should not search only Produce when its Product is Plants & seeds.
     Evaluate ranking and expansion before choosing limits or adding indexes.
  2. 🤔 ✨ **Separate existing attachments from visual matches.** Show “already
     attached here” as an existing relationship, not a new model suggestion or
     independent proof. Preserve the no-self-comparison rule. Distinguish
     insufficient independent reference imagery from a rejected visual match;
     never infer exact cultivar, model, size, ownership, or physical-instance
     identity from generic imagery alone.
  3. 🟢 ✨ **Explain identification coverage in the UI.** Show selected category,
     candidates considered, truncation, and whether independent visual evidence
     was available. A bounded no-match result must not imply an exhaustive
     search. Keep readable reasons primary and raw diagnostics expandable.
  4. 🤔 🧪 **Evaluate retrieval separately from matching.** Use a small labeled
     set spanning clothing, packaged goods, visually similar tools, plants,
     and related parts/views. Measure whether the correct Product reached the
     roster, match precision/recall, abstentions, category mistakes, truncation,
     missing reference images, latency, and per-provider cost. Include
     plant-versus-produce confusion and same-image-only attachments; compare
     prompt/ranking changes on held-out examples before claiming improvement.
  5. 🤔 ✨ **Broader workflows and budgeted escalation.** Support multi-item
     shelf/wardrobe proposals, plants, receipts/documents, older-photo search,
     and inventory recount review. Escalate useful unresolved questions through
     AI Gateway within explicit interactive and backfill budgets; preserve
     confirmation for attachment, creation, merge, and inventory changes.
  6. ⏳ ✨ **Feed visual identity ranking into native import review.** Connect
     independently evidenced cover/cutout comparisons to `PhotoEvidenceScorer`
     when measured wardrobe imports show deterministic evidence leaving the
     chooser in default order. Reuse the existing single-image ranking path
     rather than introducing a second matcher.

- ⏳ 🛠️ **Shared Vision gate for photo analysis.** The classification sweep (2 concurrent) and the review sheet's
  `LocalPhotoAnalyzer` (4) share no Vision gate. Promote if a review-sheet
  analysis measurably slows while the sweep runs: add a `PhotoVisionGate`
  actor both acquire, with the sheet yielding the sweep.

- ⏳ 🧪 **Product match queue recall and cost.** Each unfocused queue read now
  logs `queue read coverage`: vector lookups, unseeded photo Products, and
  photo Products with no candidate at all, split by whether they were seeded.
  Promote widening, caching, or write-time detection only when those logs from
  a real wardrobe import show unseeded photos without candidates that a person
  later matched (`apps/web/src/server/services/product-match.service.ts`).

- 🤔 🧪 **Reproduce macOS photo-match export inside the sandbox.** Capture the
  error chain and sandbox denial for Downloads, Desktop, and an iCloud
  Drive/file-provider destination before choosing between exact-file
  authorization, coordinated writes, or per-file copying. Keep the existing
  user-selected entitlement; no broad access or persistent bookmarks.

- ⏳ ✨ **Image provenance follow-ups.** Each promotes on its own trigger:
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

- ⏳ 🐛 **Decode bytes in image verification.** Promote when a corrupt or fully
  transparent cover is next found by eye. `inspectImageFile`
  (`services/image-integrity.ts`) never rasterizes, so
  `product_enrichment.verify_images` reports `verified` for files that will not
  render; a subagent citing it is not proof of a good image.

- ⏳ 🐛 **Exact entity attribution for `image.attach_files`.** Promote if
  mixed-entity batches distort the MCP usage dashboard; telemetry attributes a
  batch to its first item's entity.

- ⏳ ✨ **Apparel photo routing.** Routing categories are plants, food,
  documents, and home. Revisit an apparel category once the hosted coordinator
  routes photos. Size and color stay in the Product name and notes, one Product
  per variant; structured size/color fields are not planned.

- ⏳ 🧪 **Driven simulator smoke for the photo flow.** Promote when the next
  SwiftUI identity/state bug ships. `simctl addmedia` two fixture photos, drive
  select A → Add to… → Cancel → Clear → select B → Add to… via Axiom `xcui`,
  and assert the hero names B. Run from `apple-check.sh` behind a flag, outside
  the pre-push gate.

See also the image operational passes at the end of this file.

---

## Purchases, finance & household ledger

### Import and resume orders reliably

- 🤔 🐛 **Expose actionable child-row integrity diagnostics.** A live outside
  identifier can still point to a deleted Expense, but the public referential
  liveness report exposes only the edge description, without affected source
  or target handles. Expose member-eligible record handles and identifier
  evidence before designing a reviewed public repair. Distinguish retiring
  stale metadata from transferring a real source claim; preserve signed money,
  provenance and historical associations, and never substitute direct SQL
  cleanup for a supported writer.

- 🤔 🐛 **Generalize accepted-original Product repair preparation lookup.**
  The reviewed mail repair requires one exact retained preparation. Non-mail
  sources can legitimately use different source and evidence checksums, and
  repeated identical preparations can leave several exact candidates. Add
  persisted regressions before relaxing these safe refusals: preserve original
  identity and candidate-review fingerprints, accept only equivalent snapshots,
  and keep unknown historical originals unrepairable without authentic evidence.
  Compare canonical Product-association retention between import and reviewed
  reconciliation when the same source family uses a new order key; both paths
  must preserve complete observation bindings without duplicating canonical rows.

- 🤔 🧪 **Complete durable historical discovery coverage and transport evidence.**
  Owned discovery reads expose the frozen scope, current cursor/checkpoint,
  retained approval receipts and recorded AI usage. Historical readiness still
  lacks a cumulative coverage ledger and persisted Gmail request/retry history.
  Record these through the owning Workflow; distinguish current coverage from
  each Run's observations and unpriced usage from measured spend. Reading
  readiness must never restart scanning or admit imports.

- 🤔 🛠️ **Clarify explicit selection of an already-admitted Email.** A member's
  selection can reuse an automatic Run through existing source ownership or
  replay identity, retaining that Run's original execution authority. Surface
  the existing owner or offer a bounded reviewed handoff without unpausing its
  whole discovery batch; preserve source history and frozen scope.

- ⏳ 🐛 **Gmail discovery re-authentication.** Promote when production Gmail
  returns 401/403 after refresh-token expiry or revocation: actionable
  reconnect, resumable Problem, never an "empty mailbox".

### Reconcile charges and refunds

- 🧱 ✨ **Record points and miles redemptions.** An award ticket's fare is a $0
  principal Expense; only its taxes and fees are money. Record the loyalty
  program, points spent, and an optional cents-per-point value on the Expense,
  outside `cost`, so a trip Project can show cash plus points without breaking
  `SUM(Expense.cost)`. Decide whether a per-program balance is in scope.

### Review and apply corrections

- 🤔 🛠️ **Review later printed dates against email-derived order dates.**
  Missing confirmation dates now default from retained Email with field-scoped
  provenance. Design a reviewed correction that recognizes an unchanged
  fallback versus a member override and updates only acquisition Expenses
  still carrying that fallback. Preserve payment posting, refund and shipment
  event dates and accepted source replay; never bulk-shift independent dates.

- 🤔 🛠️ **Simplify tests with unnecessary infrastructure dependencies.** Audit
  tests that start PostgreSQL, IntegreSQL, Workers or other services even though
  the assertion only inspects pure schemas or generated declarations. MCP
  catalog publication, read-only homogeneity and portability/size now run in
  `catalog-schema.unit.test.ts` without database setup; audit the remaining
  service-backed suites. Move suitable behavioral checks to the unit tier,
  preserve their named regressions before deleting old copies, and keep
  real persistence and boundary checks in integration/E2E. Measure setup cost
  and avoid adding mocks merely to relocate a test.

## Import pipeline architecture

[ADR 0010](adr/0010-mail-import-unattended-burn-down-interactive.md) owns the
unattended Mail import / interactive Burn-down boundary.

- ⏳ 🛠️ **Reclaim retired research storage.** Migration
  `0034_drop_retired_research.sql` drops `RunFactEvidence`, `RunEvidence`,
  `RunOrderCandidate`, `ResearchSourceExposure`, `ResearchRetention` and
  `ImportHunt`; their code left with it. Remaining operator steps:
  - Before deploying 0034 (and after 0033), capture privately, outside the
    repository, the `RunEvidence` object keys no Image or derivative names —
    0034 removes the only record of them:

    ```sql
    SELECT re."objectKey", re."byteSize", re."kind", re."runId", re."createdAt"
    FROM "RunEvidence" re
    WHERE NOT EXISTS (SELECT 1 FROM "Image" i WHERE i."key" = re."objectKey")
      AND NOT EXISTS (
        SELECT 1 FROM "ImageDerivative" d WHERE d."key" = re."objectKey")
    ORDER BY re."objectKey";
    ```

    `Image` deliberately includes soft-deleted rows; they still own their
    object (see [recover R2 orphans](runbooks/recover-r2-orphans.md)). After
    the deploy, delete exactly those keys from R2 by hand; no repository code
    deletes them.

  - The generated `/api/import/evidence` byte read (`run.readEvidenceMedia`)
    has no server handler since #1846. Delete it with the native retained-media
    viewer (`RecordsBlockView.swift` `ReportRetainedMedia`,
    `CubbyClient.reportMedia`) in an Apple change.
  - Drop VendorAccount `browser`, `browserSyncEnabled`, `cursor` and the
    `paused_*` statuses from the manifest, `repo/vendor-account.ts` and the
    Gmail account default. The native client decodes them as required fields
    of `VendorAccountDetail`, so this needs an
    `APPLE_CLIENT_COMPATIBILITY_VERSION` bump and a column-dropping migration
    that maps `paused_*` rows to a surviving status.

- 🤔 ✨ **Server-side web search for Mail import.** Reintroduce `web_*` for Pi on
  [Cloudflare web search](https://developers.cloudflare.com/web-search/) to fill
  logged-out gaps an Email leaves (manufacturer, model, image), within the paid
  caps. It cannot reach logged-in order pages; those stay Burn-down work.
  Compare filled-at-import quality against Burn-down cost before adopting.

- ⏳ 🧪 **Tune decision and relevance prompts from measured conflicts.**
  Promote once the decision-model Email triage has deployed and 0042 has run.
  Follow `.claude/skills/decision-grading`: grade a stratified sample over
  MCP, preview it with `imports_read.mail_triage_preview`, reclassify the
  existing uncertain backlog in batches of 200, and revise the triage,
  relevance and `mail.resolve` linking prompts (or tighten the link-suggestion
  heuristic when Purchase link proposals a member dismissed, by proposer,
  dominate) only when a held-out sample improves.

- ⏳ 🧪 **Finish client acceptance of historical prepared-candidate review.**
  [PR #1892](https://github.com/nickysemenza/cubby/pull/1892) preserves missing
  historical `exactNameMatch` judgments as null, with a persisted Run-detail
  regression. Deployment and the public `run_status` reader are verified.
  Findings-panel acceptance remains separate; preserve candidate snapshots and
  recheck current identity at commit. Installed-client acceptance is excluded
  from the current member-directed closeout.

- 🤔 🐛 **Clarify identifier-issuer collision diagnostics.** A reviewed receipt
  preparation refused because two Vendors claimed the product-page host. The
  error text exposed the issuer ambiguity, while the connector's structured
  result reported only `INVALID_ARGUMENT`. Preserve the diagnostic cause and
  expose the conflicting Vendor identities so the member can correct their
  recorded websites without merging distinct merchants. Read both error text
  and structured content before diagnosing a connector validation failure.

- 🤔 🐛 **Fix import commit errors after a completed durable operation.** A member
  commit returned `Import run ownership is unavailable` after its operation
  ledger had completed with a persisted source-reconciliation finding. Add a
  failing boundary regression before changing the response/finalization path.
  Return the durable result accurately; callers must read `purchase_status`
  with the original operation identity before retrying an ambiguous response.

- 🤔 🛠️ **Continue durable mechanical backfills after the AI bulk migration.**
  UPC image backfill and page-oriented image maintenance are the next candidates
  for shared durable execution. Select concrete recovery gaps and reuse the
  infrastructure in [ADR 0015](adr/0015-unified-durable-work-coordination.md). Agent,
  device, queue, telemetry and interactive runtime migration needs evidence of
  meaningful duplication or a demonstrated recovery failure.

- 🤔 🐛 **Settle a member search's abandoned matches.** A member's `mail.search`
  runs only the free rule stage, so every new non-Spam/Trash match is retained
  as `uncertain` (an already-decided Email keeps its Relevance) until the session settles it with `mail.resolve`. A session that
  ends early leaves those copies retained. Either expire unsettled member
  matches or let members retain one Email by Gmail id instead of searching.

- 🤔 ✨ **Expose conflicting supplier specifications during research.** An exact
  supplier page can give incompatible values in its description and detail
  table. Retain both observations and ask for field-specific resolution before
  accepting that specification; page authority alone does not resolve an
  internal contradiction. Preserve already supported identity and assignments.

- ⏳ 🧪 **Accept live Mail import and Burn-down.** Historical discovery and
  unattended bulk admission remain paused until the member resumes each scope.
  Interactive member-directed repairs can continue independently. The approved
  Product scope has completed source-backed
  acceptance, including the member's packaging-label confirmations. Remaining
  acceptance: live verification that imports refuse exact-identity Product forks and
  resolve Vendors by Sender proof or Vendor alias, known-vendor and
  unmatched-transaction backfills, full Gmail history excluding Spam/Trash, separately verified
  continuous new-mail processing, and persisted Purchases, Products, related
  Emails, financial events, Sources and images, plus Spending. Installed-client
  acceptance is excluded at the member's request. Paid Gateway fallback stays within the existing caps ($10 pilot, $10
  historical backfill, $10/month continuous) with durable known-price admission
  before every paid transmission; prefer subscription inference. Populated
  fields and terminal Runs do not establish verification.

- ⏳ 🧪 **Reconcile findings and measure abstention after Email convergence.**
  Reconcile the evidence-backed financial and findings worklist through public
  writers, preserving signed refunds, claims, party cents and stock; a healthy
  detector count does not accept an older audit. A legacy finding without its
  original message roster cannot be dismissed from sender identity or today's
  Expenses. Measure rule-driven abstention (including oversized and multipart
  evidence) separately from model uncertainty, with independent grades and exact
  message availability before any accuracy claim. Present historical restart
  readiness before requesting a new historical authorization.

- 🟢 🧪 **Cover the `replace_aggregate_line` fix path.** No integration test
  applies an audit-proposed aggregate replacement; the first exact-identity
  guard broke its `distinctFrom` carry unnoticed. Add a commit → finding →
  approve case whose line carries a Distinct-from decision.

- 🤔 ✨ **Support reviewed category attribution for negative price adjustments.**
  A subscription upgrade invoice can credit unused time from its prior plan.
  Preserve that signed `other_adjustment` and its source; do not relabel it as
  a discount or alter the amount to force category completeness. Current
  allocation leaves these credits unknown alongside positive principal lines,
  and the Expense classification constraint rejects direct category assignment.
  Add a source-backed reviewed attribution path through the generic model, and
  make its preview reject unsupported assignments before an apply reaches the
  database constraint. Preserve project/party cents and payment allocations.

- ⏳ 🧪 **Measure paid fallback recovery.** A bounded live attempt saw the exact
  quota refusal inside an HTTP 200 stream; the shared router now qualifies it
  before admission, but live paid recovery after that refusal is unproven.

- 🤔 ✨ **Gmail push for continuous new mail.** The daily cron plus backfill
  covers new mail today; Gmail push notifications would shorten the delay.
  Decide only after continuous processing is verified.

## Runs, enrichment & browser capture

- 🤔 🐛 **Fence the HTTP coordinator proxy by Run ownership.** Its route verifies
  member identity, but `proxyPurchaseAgentRequest` receives a party without
  checking it against the Run owner. Apply the owned transcript reader's
  actor-and-party fence to GET, streaming and control requests, with a real
  foreign-Run regression before dispatch.

- 🤔 🐛 **Keep live conversation inspection from resuming Pi.** The existing
  HTTP GET/stream path loads the Agent lifecycle, whose cold-start harness
  recovery can resume pending work. Move UI inspection onto a storage-only
  projection/subscription path while preserving committed history and live
  updates; follow the MCP reader's cold-start regression in `agent-host.ts`.

Run is the one unit of unattended work (Mail import, photo inventory, a member's
import) and the attempt history the shared activity projection presents.
Burn-down writes are not Runs: they are audited member writes with Sources.

- 🤔 🐛 **Preserve chronological timestamps for completed approval Runs.** A
  completed execution-authorization root can end before its recorded start and
  trigger a timeline defect. Reproduce with synthetic approval creation, use
  one consistent clock for the terminal receipt, and preserve existing approval
  fingerprints, receipts and budget state during any historical repair.

- 🤔 🐛 **Refresh aggregate problem counts after statement membership and finding
  writes.** Targeted reads can show repaired export coverage or dismissed
  findings while aggregate counts retain older totals. Investigate cache
  invalidation and shared read dependencies; verify both projections converge
  without changing declared source counts or dismissing unresolved evidence.

- 🤔 🐛 **Distinguish blank browser captures from usable order documents.** A
  retained PDF or image can contain only an empty browser page while still
  satisfying primary-document presence. Preserve the original capture and its
  history, record the missing evidence explicitly, and verify usable replacement
  evidence before treating document presence as source acceptance.

- 🤔 🐛 **Repair Run-list attention projection validation.** A live Runs page can
  reject its attention and list payload when a target's `entityKind` falls
  outside the declared purchase/product/image/run enum. Reproduce using a
  synthetic target, align the shared projection contract with supported target
  kinds, and verify the list and attention summaries render. Individual Run
  detail pages still load; preserve their retained history.

- 🧱 🛠️ **Declare image jobs as an entity.** Runs list and inspect through the
  generic Run table, but image-processing jobs still need the hand-written
  Image jobs view (`apps/web/src/app/runs/image-job-history.tsx`), their own
  inspector (`ActivityRunDetail`, `RunWorkFacts`) and the `/runs/jobs/$id`
  page. Declaring them in the manifest (shortcode, state, kind, subject,
  attempts, cost) lets the generic list, inspector and detail page replace all
  three; plan the identifier and attempts storage first.

- 🤔 🛠️ **Trim the activity projection to what clients still read.** The web
  reads `activity.list`/`detail`/`events` only for image jobs now, and no
  longer reads `activity.groups`/`groupChildren` at all. Check the native
  Activity screen and the MCP `activity` tool before narrowing these
  operations to image jobs or deleting the Run grouping reads.

- ⏳ ✨ **Show the Research queue count where the household looks.** Surface the
  `research-queue` saved-view counts on Home or Activity, linking to the views,
  so Burn-down happens; no notifications or scheduling.

- ⏳ 🧪 **Accept research root grouping and record-level history in the
  clients.** The grouped Activity reads and the Purchase/Vendor/Vendor Account
  Emails sections ship on web and native; installed-household acceptance
  remains.

- 🤔 ✨ **Link enriched seed Products to Plants.** `growsPlantId` is supported,
  but which growing facts belong on Plant versus a purchased seed Product is a
  separate domain decision.

- 🤔 🧪 **Measure Mail import model routing before changing it.** Keep Luna by
  default until a controlled comparison on the same sources shows a safe
  alternative for purchased-variant judgments.

## Ingredients, recipes & nutrition

- 🧱 ✨ **Ingredient as the grocery hub.** Product is SKU-grade and Ingredient
  the commodity layer, but imports never fill `ingredientId`, so
  `Cauliflower` / `Organic Cauliflower, 1 Each` and three ground-beef 80/20s
  stand unconnected. In order:
  1. 🧱 ✨ Piece units resolve on the ingredient: `whole/bunch/crown/clove` come
     from USDA `portionInfo` or an ingredient-level mapping; product `each`
     prices the package and never satisfies a piece unit.
  2. 🧱 ✨ A durable ingredient-level unit mapping store, which the harvested
     equivalences report (`lib/harvest-equivalences.ts`) then writes accepted
     suggestions into.

- 🧱 ✨ **Salt amounts for “to taste” recipe lines.** Sanity-check the proposed
  1% of pot weight and define its applicability and evidence before changing
  parser or costing contracts. This estimation policy remains future work.

- 🧱 ✨ **Cookbook identity merge.** Give cookbooks durable identity plus a
  merge/repoint path to stop same-title collisions and renamed-EPUB forks. A
  recipe changes cookbook only to fix an import, so merge/repoint is the
  sanctioned path; record `cookbookId` changes in the recipe audit roster
  (`server/repo/recipe/crud.ts`) and decide whether the recipe form's cookbook
  picker (`recipe-cookbook-field.tsx`, `resolveCookbookRepoint`) stays.

- 🧱 ✨ **Portion shares alongside grams.** Accept `{share}` per portion in
  `meal_recipe.save_preparation` and derive grams at read time from the
  current `estimatedYieldGrams`, so served-by-eye portions do not go stale.

- 🤔 🧪 **Cookbook fallback evaluation.** Run the six-book answer-key corpus
  against GPT-6 Luna as the second ladder reader; compare recall, escalation
  rate, latency, and cost. Keep Gemini 2.5 Flash as first reader meanwhile.

- ⏳ 🐛 **Explicit idempotency key for `meal_recipe.add`.** Promote if a re-sent
  call duplicates a meal line. Not a natural-key index: one meal may repeat a
  recipe at different scales. First slice is an `operations/meal.server.ts`
  integration test asserting one meal holds one recipe twice with two
  independent shopping-list contributions.

- ⏳ ✨ **Exact nutrition source tracing.** Resume with upstream conversion work:
  `ingredient-parser` reports retain actual mapping identities and competing
  mappings; Cubby exposes Product/USDA/manual provenance through nutrient
  cells and nested recipes from the same computation, never inferred from
  matching values.

- ⏳ ✨ **Split compound ingredient lines.** Blocked upstream: `parse_ingredient`
  is singular and keeps "Salt and pepper" whole. Scope when unblocked: compound ingredient rows with empty `amounts`
  (the discriminator). Choose split targets from `rawLine`; route writes through
  `handleSectionUpdates` sending each section's complete array; repoint the
  existing row to the first child. MCP cannot drive it (no line ids).

- ⏳ ✨ **Portion solver.** Promote if agent-side amount iteration stays painful;
  solve component weights against macro constraints in one call.

- ⏳ ✨ **Aggregate range materiality.** Promote if always-on cost/calorie/weight
  ranges create visible noise; collapse only immaterial aggregate spreads.

- 🔭 ✨ **Recipe scaling extensions.** Pan-size targets, interactive parse
  clarification, and baker's-percentage comparison without a global density
  table.

---

## Inventory, products & locations

- 🤔 🧪 **Measure duplicate-candidate recall beyond live lexical matching.**
  The purchase-import pre-create fence now reviews strong brand/item word matches without
  waiting for indexing. Evaluate abbreviated receipt names, missing brands
  and visually described photo Products against the existing semantic/photo
  candidate paths. Add recall only where measured misses justify it; keep
  variant evidence and reviewed reuse-or-distinct decisions, never automatic
  merges from an embedding score.

- 🤔 🐛 **Accept legitimate fractional acquisition quantities in Product pricing
  reads.** A detailed Product read can fail validation because
  `pricing.knownUnitCount` requires an integer even when acquiring Expenses
  carry fractional quantities. Trace the quantity/unit contract and preserve
  recorded money and physical stock; add a synthetic regression before fixing
  the projection or schema. Do not round real quantities to satisfy validation.

- ⏳ ✨ **Collapse a Product's entries into one Wardrobe card.** One Inventory
  entry already holds every copy with the same owner, Location and placement,
  so v1 cards show an amount badge, and a second card means a second Location.
  Promote if the same Product spread across Locations clutters a gallery;
  collapsing needs a paging/count unit, a quantity sum across units, and a
  per-entry target for actions such as owner confirmation.

- ⏳ 🛠️ **Set-based SQL for effective Inventory ownership.** The owner filter
  runs the TypeScript ownership resolver (`repo/inventory/ownership.ts`) over
  live stock and injects the matching ids before paging. Promote if that makes
  Inventory lists measurably slow; a SQL form must keep the resolver's
  ambiguity rules (one acquisition, conflicting beneficiaries, invalid account
  defaults), not a fallback chain, and needs parity tests against the resolver.

- 🔭 ✨ **Wear history and outfits for Wardrobe.** Logging when a garment is
  worn, building outfits, and a "not worn in a year" cleanup view. Wardrobe v1
  is browse plus needs-attention; this is a new domain (wear events) and was
  explicitly deferred as a maybe.

---

## Tasks, projects & garden

- 🔭 ✨ **Grow-to-table loop.** Beds and plantings, harvests received into pantry
  inventory, and what the yard can supply this week.

- 🔭 ✨ **Seasonal garden planning and photo comparison.** Build past one-time
  `garden-plan-import` toward revising a standing plan season over season,
  comparing dated bed photos with AI, and explaining keep-versus-replace
  recommendations. Planting windows alone do not establish harvest forecasts.

---

## Native app

- 🤔 🛠️ **Untype the largest native RPC outputs.** After the entity kernel
  went untyped, the generated client's biggest remaining schema closures are
  typed RPC outputs (bytes of the 200 response's component closure in the
  Apple `openapi.json`): `product.createWithInventory` ~54 KB,
  `run.workSnapshot`/`run.control`/`run.work` ~36 KB each,
  `project.dashboardSummary` ~32 KB, the inventory family
  (`bulkAdd`, `receiveExpense`, `reconcileSession`, `moveEntries`,
  `locationSnapshot`, `getByLocationIds`) ~27 KB each, `usda-food.list`
  ~27 KB; `RunDetail` and `EmailAccuracyReport` ride inside the run outputs.
  Decide per output whether Swift needs the typed fields or can read
  `JSONValue` through the manifest, and move the `NATIVE_TYPED_RECORDS`
  keep-list views (`type-overrides.ts`) onto the entity manifest so that list
  only shrinks.
- 🤔 🛠️ **Merge overlapping single-record reads.** `entity.detail`,
  `entityReport.get` and `collection.referenceDetail` each load one record by
  shortcode with different envelopes; establish whether native and web can
  share one read before changing any contract.
- 🤔 🛠️ **Drop `native:` flags with no Swift caller.** The flag puts an
  operation on HTTP and in the generated Swift client. These have no Swift
  call site but some have E2E, skill, or doc callers over HTTP, so move each
  caller to the Start transport or MCP first: `activity.submission`,
  `entity.graphPaths`, `imageProcessing.{correctDescription,
  evaluateAppleDescription,retry,schedule,validateCompanionMessage}`,
  `inventory.getByLocationIds`, `product.{createWithInventory,
  findOrCreateByUPC}`, `purchaseImport.{commitAcceptedReconciliation,
  emailAccuracyBlind,emailAccuracyGrade,emailAccuracyReport,
  prepareReconciliation}`, `run.{approveExecution,discoverMail,
  executionMailboxes,work,aiUsage}`.
- 🟢 🛠️ **Derive `DevicePlatform` from the manifest.** The Device platform
  enum is hand-written in `DeviceRegistration.swift` since the typed Device
  resource left the generated client; generate it from the field's declared
  options instead.
- 🟢 🧪 **Check the RecordList parity screens in a simulator.** The merged
  Connected records section ("+N more" into the paged per-view list,
  kind-labelled paths, per-row hops) and folded "N updates · M fields" rows
  in Changes and Today passed host tests and a simulator build but were never
  viewed or covered by `test:e2e:sim`.
- 🤔 ✨ **Add per-record History on native.** Web History hides the record's
  own name and folds update bursts; native has no per-record History view, so
  only Changes and Today fold (`AuditEntryFolding`). Decide whether a record
  detail needs one.
- 🤔 🐛 **Cluster and reproduce the native app-hang corpus before changing
  code.** Collect sanitized release, duration, foreground state, and top
  symbolicated main-thread frames per Sentry family; group by shared frames.
  Reproduce each in a Release build without LLDB (Time Profiler or System
  Trace) and make one repair per demonstrated root cause.

- 🤔 🧪 **Swift 6.4 / OS 27 readiness pass.** Before a toolchain or floor change,
  audit state initialization, concurrency, availability, and resizing against
  the actual SDK with focused behavior tests. Preserve the OS 26 path until a
  floor bump is chosen. Owners: `apps/apple/project.yml`, `App`, `CubbyKit`.

- 🤔 ✨ **Live Activities for server runs started on this device.** Record the
  initiating install separately from `ActivityRun.executors`, then send
  ActivityKit push updates so the phone shows progress while suspended. Keep
  the local-work Live Activity feed separate.

- 🤔 🧪 **Judge the hosted Run evidence pilot.** Run evidence (transcript,
  logs, AI usage) is the one hosted native view
  ([bridge contract](../apps/apple/DESIGN.md#run-evidence-pilot)). Measure cold
  and warm opening on synthetic records against native detail and judge shared
  implementation benefit together with the Apple experience before any broader
  hosted detail adoption. Apple details still need a density pass that keeps
  native hit targets and Dynamic Type.

- ⏳ ✨ **Native workflow parity with web.** Promote when a recurring household
  task still needs the web. Coverage is declared once in
  `packages/schemas/src/native-coverage.ts` with a shrink-only unsupported
  ceiling per kind. Every control, list cell, detail renderer and hero action
  is native. Remaining gaps: two Run detail slots (the live and stopped
  agent conversation, which stream over the coordinator's own protocol; see the next
  item) and the few web-only parts listed under "Web-only parts inside the
  implemented native slots". Add editor focus order or
  comprehensive sheet lifecycle only on demonstrated friction. Owners:
  `apps/apple/App/Shared`, generated `EntityCatalog`.

- ⏳ ✨ **Native agent conversation streaming.** The live and stopped agent slots
  (`run.import-agent-live`, `run.import-agent-stopped`) stay web-only on
  purpose: the conversation is the coordinator's SSE stream plus prompt and abort over
  `/api/import/runs/{id}/agent/*` (`apps/web/src/routes/api/import/`), not a
  Cubby operation, so nothing in the OpenAPI client reaches it. Native needs an
  agent client in CubbyKit (authenticated SSE read, prompt POST, the abort that
  cancels the run), reconnect with resume after a
  suspended or dropped connection, and a transcript model that folds stream
  events into the durable timeline (which native already draws from
  `run.import-timeline`). Promote when a household member needs to prompt or
  steer a running import from the phone instead of waiting for it to pause on
  web, then lower `NATIVE_UNSUPPORTED_CEILING.detailSlot` to zero.

- ⏳ ✨ **Structured-value editor follow-ups.** Web and native edit every
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

- ⏳ ✨ **Native recipe Share extension.** An iOS and macOS share-sheet extension
  that sends a shared recipe URL to the existing server recipe import, reading
  the session token from a Keychain access group shared with the app. Promote
  when sharing recipes from the phone is wanted. Retiring the web manifest
  dropped `share_target` from installed Chromium/Android PWAs only; iOS Safari
  never supported Web Share Target, so nothing iOS-facing was lost.

- ⏳ ✨ **Core native inventory experience.** Promote when everyday use exposes a
  specific bottleneck: location-first browsing, stock comparison,
  capture/recount, photo completion. Owners: `App/Shared/Browse`, `Capture`,
  `Audit`; see [native design](../apps/apple/DESIGN.md).

- ⏳ 🛠️ **Generated native list/detail parity.** Stay on generated `EntityCatalog`
  and OpenAPI; revisit shared Rust only for a rule those surfaces cannot
  express. Add collapsed-section parity only for a manifest-supported consumer.

- ⏳ ✨ **Native numeric entry and units.** Promote only when a native amount
  workflow shows decimal fields are insufficient; define locale-aware parsing
  and the unit contract first.

- ⏳ ✨ **Native system-surface expansion.** One surface at a time once a
  workflow names it: Quick Look, typed drag/drop, App Intents, widgets,
  extensions, voice, timers. Keep confirmed writes and existing contracts.

- ⏳ ✨ **On-device Apple Intelligence.** Promote when devices and a measured
  capture friction justify one draft-assistance workflow; evaluate on
  fixtures and confirm before writes. Owners: `App/Shared/Identify`, `Photo`,
  `Intents`.

- ⏳ ✨ **Offline native writes and multiwindow.** Promote only when disconnected
  use or concurrent windows block a workflow; needs a write/retry/conflict
  model and window ownership rules.

- ⏳ ✨ **Web-only parts inside the implemented native slots.** What is left
  after the report commands: the recipe flow's "map" layout (a graph drawing);
  non-recipe foods and moving a portion to another meal (leftovers) in a meal's
  composition; the web cookbook reprocess progress bar (native runs the same
  workflow to its end and shows the summary). Promote one when a household
  task needs it on the phone.

- ⏳ ✨ **Expose the rest of recipebridge via cubby-ffi.** Scaling (`scale_amount`,
  every scale-factor anchor including total weight, scaled counts) ships with
  native cook mode. Conversion,
  needs, costing, and nutrition stay web-only until a native screen prices a
  meal or shows a costed recipe.

---

## Web UI

- 🟢 ✨ **Give the detail-page explorer a depth control.** A detail page's
  Relationships section is the graph explorer alone (`EntityRelations
  placement="detail"`), with a find box and list toggle but no depth picker.
  Offer depth 2–3 there; depth 1 repeats the record's relation tables.
- 🤔 🐛 **Review behaviour changes from the RecordList migration.**
  - The home meals card links only the meal label rather than the whole row
    (`features/home/MealsCard.tsx`); decide whether the row is the target.
  - Lists in narrow popovers (recipe totals gaps, smart-collection match
    evidence) sit below the ledger's 32rem two-column width, so the totals-gap
    fix link drops beneath its suggestion.
  - `record-list.css` sets row `min-height`, which overrides a row's Tailwind
    `min-h-*`; decide whether rows may opt into a taller floor.
- 🤔 🛠️ **Revisit the hand-rolled record list baseline.** The
  `cubby/no-hand-rolled-record-list` exemptions in `.oxlintrc.json`: recipe
  ingredient prose (`RecipeMagazineView.tsx`, `recipe-live-preview.tsx`) and
  the meal nutrition workspace are likely permanent; the collection
  assignment matrix (per-row toggles) and the application directory
  (navigation) move to `RecordList` only if they become read-only record
  lists.
- 🟢 ✨ **Filter Activity by action and writer.** The RecordList timeline
  folds bursts and links the Run behind a write; chips for create/update/
  delete and for people versus agents would narrow a long History without a
  second page.
- 🤔 ✨ **Merge a Run's system log into its Activity timeline.** The Run
  "System and agent log" report and the Run's audit changes are both dated
  rows on the same timeline geometry; interleaving them would show what an
  agent did beside what it wrote.
- 🟢 🐛 **Show unmatched edit issues in the dialog banner.** A validation issue
  whose path has no rendered control (e.g. `externalIds.0.isPrimary`) is set on
  the form but never shown: `entityEditBannerIssues`
  (`entity-edit-dialog-content.tsx`) excludes every field-scoped issue, so Save
  fails silently. Surface issues no registered control can display.
- 🟢 ✨ **Spill clipped names outside tables.** `useCellSpill` lifts a clipped
  table value or header over its neighbours on hover or focus; the same
  overlay would read truncated names elsewhere without a tooltip. Generalise
  the hook's root from a table pane to any container that opts in, rather
  than adding a second overlay:
  - Pickers: long option names in `ui/combobox/entity-picker.tsx` and
    `ui/primitives/combobox.tsx` ("Synthetic pantry staples and long-keeping
    dry…").
  - Record lists: `EntityRefLink variant="list"` rows
    (`entity/components/ref-link/list.tsx`) in detail-page related sections
    and `ui/DocumentViewerList.tsx` file names.
  - Navigation: sidebar entries and group labels
    (`ui/navigation/sidebar-rail-group.tsx`, `workspace-navigator.tsx`) and
    the shell's page title in `authenticated-app-shell.tsx`.
- 🤔 🛠️ **RTable visual polish pass.** Quieter cells read as finished; the
  mocked target has fewer marks and type-led hierarchy. Start with
  `cubby-ui-design-audit` measuring live computed styles against the mock,
  then land what holds up, updating `apps/web/DESIGN.md` (RTable):
  - Drop the tag glyph on every category chip; the chip already says "tag".
  - Lighter status pills: 12px text, ~2px vertical padding, softer borders,
    well short of the row height.
  - Quieter headers: 12px medium muted label, one stronger bottom rule.
  - Monospace only for codes and shortcodes, never timestamps or counts.
  - Secondary values as a muted smaller line or tone, never in parentheses.
  - Fainter column rules and row separators than the header boundary.
  - Audit the remaining per-cell icons (hierarchy, external link) for the
    every-row repetition the ⓘ and relation controls dropped; keep one only
    where it changes the action.
  - Apple list headers could read `display.columnLabel` too; the generated
    Swift catalog does not carry it yet.
- 🤔 ✨ **All-entities record interaction parity.** Reuse standard row inspection,
  selection, clipboard behavior, and actions in the Records tab. Decide which
  actions are eligible for mixed entity types before enabling batch work;
  build on `EntityRecordsTab` and shared RTable behavior.

- 🤔 ✨ **Make narrow web layouts device agnostic.** The compact shell still uses
  phone-style tabs and overlays. Design one compact navigation and overlay
  pattern for narrow widths on desktop and iPhone, keyed on width, keeping
  safe-area, keyboard, and touch behavior where exposed; update the design
  language and responsive checks.

- 🤔 ✨ **Phone hit areas as pseudo-elements, app-wide.** Button's
  `mobileSize: "touch"` grows icon controls to 44px layout boxes, wrapping
  dense rows. The detail ledger keeps the target as an `::after` (the
  `checkbox.tsx` pattern). Decide whether `touch` itself becomes a
  pseudo-element target.

- 🤔 🛠️ **List-route SSR payloads are large.** `/projects` 826 KB, `/locations`
  655 KB, `/recipes` 579 KB of HTML. Find what the list loader and slot views
  dehydrate before trimming or deferring.

- 🤔 🧪 **Eyeball `/graph` after the canonical-owner change.** #1067 made the
  foreign-key side own a shared path, so `product → inventory` now reads
  `inventory → product`; inspect the Relationships tab and `/graph` for
  relations declared on both sides.

- 🤔 ✨ **Server-backed table intelligence.** Extend exact facet counts and
  aggregate summaries from Expenses to one justified server-paginated surface
  at a time; never analyze a partial client page as the population.

- ⏳ 🐛 **Named web fidelity losses from the manifest-rendering pass.** Promote
  if a workflow misses one: the interactive subtask checklist, project's
  tasks list/board toggle, purchase per-line quantity/unit-cost columns,
  location's merged sub-locations+items surface, product's stock-stats row.

- ⏳ 🐛 **Timeline notes carry links and product `usedOnProjects`.** Promote when
  "N products omitted" needs to be clickable again or a lifecycle row needs a
  project link; `EntityTimelineOut.notes[]` are plain strings.

- ⏳ ✨ **Push change feed for post-mutation refresh.** Promote only when a
  derived value users wait on reliably lands after the +5 s / +30 s deferred
  refetch (`lib/deferred-invalidation.ts`). Design: a Durable Object change
  feed over WebSocket Hibernation; rejected for now as ~300–400 lines of
  infrastructure for a single-household tool.

- ⏳ ✨ **Selective SSR expansion.** Promote another route family only if the
  product-detail pilot wins a cold-cache comparison without INP, CLS, or
  Worker-error regressions.

- ⏳ 🛠️ **Selection-control consolidation.** Promote a selector family when
  visual or keyboard inconsistency becomes painful.

- ⏳ 🧪 **Measured table-virtualizer investigation.** Revisit direct-DOM-write
  options only during a measured investigation (`directDomUpdates` no longer
  exists in the installed `@tanstack/react-virtual`).

- ⏳ 🛠️ **Residual N+1 repair** when a fresh trace finds concrete fan-out;
  **Sentry lazy initialization** if a fresh treemap shows Sentry on the
  critical path.

---

## Entity platform & data model

- 🟢 ✨ **Group lists by a related record's field, on web and Apple
  (high priority).** Wardrobe wants Shirts / Pants / Outerwear sections, which
  means grouping Inventory by `product.category`. Web sections today group only
  by the entity's own sort fields (`groupable`/`grouping` in
  `entity-definitions/definition.ts`, checked in `entity-kernel/list-input.ts`),
  and the Apple generic list has no sections at all (only `TaskBoardLanes`).
  Wardrobe v1 ships with subcategory filter chips and a category sort; this
  item makes sections a declared capability for every list, then gives the
  Wardrobe saved view a `groupBy`. Deferred from Wardrobe v1 because grouping
  should improve generically first, not as a wardrobe-only path.

- ⏳ ✨ **Per-member home pins.** Saved views pin to the home "Your views" row
  from their declaration, in a fixed order, and `@me` already makes the
  contents personal. Promote when the row feels crowded or members want
  different pins; that adds a stored per-member preference and a settings
  surface, which one trusted household did not need for v1.

- 🟢 ✨ **Pin the Research queue to home.** Products sorted by weakest data
  quality as a pinned saved view with a count. Left out of the first home row
  (Wardrobe, My stuff, My tasks, Needs a home) to keep it to four.

- 🤔 ✨ **Product Category feature expectations.** Decide whether Food _expects_
  an ingredient and Books an ISBN (both `unknown` today, so no data-quality
  gap) and whether a Food Product may carry an ISBN outright rather than only
  by precedence; and whether seed/plant categories should expect
  `growsPlantId` (no feature or rule exists yet). Each answer is one policy
  value in the ProductCategory manifest declaration.
  Inherited classifications (Vendor → Purchase → Expense) resolve through
  their existing effective-value SQL before a refusal applies.

- 🟢 🛠️ **Rename detail section `placement`.** With the supporting rail gone,
  `primary` and `full` no longer describe width: `primary` sections share one
  ruled card and `full` gets its own (`renderDetailGroup` in
  `apps/web/src/ui/data-table/detail-page.tsx`). Rename it to the grouping it
  now expresses (possibly folded into `surface`), and give the Apple Run
  console's full-slots-first ordering (`RunConsoleView.swift`) its own field.

- 🟢 🛠️ **Move the Email report's inferred lists onto derived relations.**
  Purchase, Vendor and Vendor Account `emails` are `derived` relationships read
  through Email list filters. The Email page still hand-composes Purchase
  Expenses, Purchase Products and Same-Purchase Emails; declare each as a
  `derived` relationship over a list filter and render it as a relation
  section, then add Product → Emails and Expense → Emails through their
  Purchases so those pages show their backing Emails.

- 🤔 ✨ **Row commands declared in the manifest.** Email Link/Dismiss is a
  registry row action whose eligibility the server decides (`ownedByViewer`,
  `accepted`) and whose scope comes from the relation section. Run fixes,
  meal recipe Remove and reconciliation Attach are still per-report commands.
  Decide a manifest declaration for a scoped row command with a server-owned
  disabled reason, then move those onto it on web and native (native Emails
  sections link and dismiss only from the Email page today).

- 🤔 ✨ **Segmented quick filters on lists and embedded tables.** An enum
  facet or the declared `savedViews` (Email: Needs attention, Review
  conflicts) could render as a segmented control on a list page and inside a
  relation section, e.g. an Emails section's Linked · Suggested · Dismissed.
  `ViewSwitcher`/`ChoiceSwitcher` and `DataTableViews` exist; decide the
  declaration (facet or saved view) and wire it generically on web and native.

- 🤔 🧪 **Record who proposed other reviewed decisions.** Email Purchase links
  keep `proposedBy` (member, agent, import, heuristic) so the Accuracy view can
  count dismissed agent proposals. Run fix decisions and photo-group review
  cannot tell an agent's proposal from a member's; record
  the proposer on each and surface dismissal rates per proposer.

- 🤔 ✨ **Declarative "many, clamped to one" cardinality.** Image provenance
  chose a many-row `ImageSighting` child plus derived `one` Image fields over
  array relations with a runtime clamp. Revisit only when a second entity needs
  multi-evidence provenance; extend relation `provenance.sources[]` first.

- 🤔 ✨ **Dependent batch program.** A bounded program of named operations whose
  results feed later inputs: limits, failure propagation, ordered partial
  outcomes, retries preserving completed writes, explicit continuation.

- 🤔 ✨ **MCP staged-file storage.** Before sharing a local upload beyond its
  signed grant, define no-copy activation, grant replay, activation fencing,
  delete-before-expiry for a recreated orphan, and evidence ownership, on the
  `EntityAttachment` model in ADR 0006.

- 🤔 ✨ **Host-provided MCP file references.** Adapt client-owned file handles
  and download URLs through capability-specific input metadata and the
  validated URL-fetch path; downloadable URLs remain the fallback.

- ⏳ ✨ **Batched HTTP kernel writes.** Promote if a 5k-asset library makes
  one-row-per-request `entity.mutate` writes measurably slow; mirror
  `entity.commands`'s independent-item semantics.

- ⏳ ✨ **Budget-aware MCP pagination.** Investigate the observed Problems
  response where an item array is shorter than its declared page size while
  pagination still advances by that larger size. Establish whether the bound
  is applied by Cubby or the connector before changing the contract; a complete
  traversal must not skip the omitted rows. Use stable keyset cursors, byte and
  result limits, and a continuation preserving filters, sort, and budget.

- ⏳ ✨ **Durable MCP transfer telemetry.** Persist call duration, response
  bytes, and per-item outcomes when repeated measurements justify it.

- ⏳ 🛠️ **Entity relation runtime dispatch.** Promote when attach/detach
  genericization resumes; generate dispatch only for declared runtime ports.

- ⏳ 🛠️ **`stored` descriptor sweep per repository.** Promote when a hand-built
  list drifts from its declared columns; convert per repository
  (`product/crud.ts`, `purchase.ts`) and verify with the real-query matrix.

- ⏳ ✨ **RunFinding as a manifest entity.** Promote once a second parent needs
  its list. It is the one run child with its own lifecycle and a Purchase
  relation; costs a prefix, a backfill, an `AuditEntityKind`, and the same
  delete/resolve disposition decision as StatementRow.

- ⏳ ✨ **StatementRow and StatementImport as manifest entities.** Promote once
  the `supersededByRowId` disposition (block, detach, or cascade) is decided.
  Unblocks auditing: all three statement-row mutation paths write no audit
  trail. Backfill shortcodes in batches with an in-memory set of existing
  codes (`generateUniqueShortcode` is per-candidate SELECT).

- ⏳ 🛠️ **Put `deleteStatementRows` on policy-driven removal.** The last
  hand-written cascade (`repo/statement-row.ts`); waits on the item above. The
  image hard delete stays on `IMAGE_HARD_DELETE` on purpose
  (`repo/removal/core.unit.test.ts`).

- ⏳ 🛠️ **Generic child-table review lists.** Several Run/import child tables
  carry a review lifecycle but no manifest identity, so each has a
  hand-written list: `Suggestion` (pending → applied/rejected/superseded; the
  `/ai` Review tab), `RunFinding` (open → applied/dismissed; Problems),
  `RunApproval` (pending operations), `PhotoGroupProposal` and
  `PhotoRunImage` (photo review), `OrderMailCandidateDecision`, and
  `StatementRow` (open disposition; overlaps the item above). Extend the
  entity compiler with a child-backed read adapter, an identity/navigation
  contract for uuid-keyed rows, and workflow actions that delegate to the
  existing handlers (not field updates; the compiler rejects update
  capabilities on read-only entities), so these render through
  `GenericEntityList`. Promote when a second review list is about to be
  rewritten; move `Suggestion` first.

---

## Classification in the manifest

- 🤔 🛠️ **Declare effective-value inheritance chains.** "Expense category =
  override → vendor food context → product mapping (category ancestors) →
  Purchase default → Vendor default" lives in hand SQL
  (`repo/expense-category-resolution.ts`), as do project inheritance and
  itemization expectation (Purchase override → Vendor → SpendingCategory
  `itemizationExpectation`, `repo/purchase-evidence-policy.ts`). Declare each
  chain and generate the resolution SQL, the "inherited from" explanation,
  and the set of Expenses a change can reach — the reach scope the reviewed
  classification preview hand-writes. Generated SQL must match hand-tuned
  performance; #1712's preview equivalence and scale tests are the guard.
  Decide the declaration shape first.
- ⏳ 🧪 **Re-evaluate categories and decision-backed dropdown options.**
  Promote once reviewed Suggestion history is readable over MCP (deployed
  `entity_read.suggestion_queue` with `status`). Review the
  category hierarchies and declared classification choices against actual usage
  and per-field decision misses, one serial read at a time (effective-value
  filters on large lists exhaust the production pool when run in parallel). Identify overlapping, ambiguous, stale or
  missing options; check that meanings and suggestion rules distinguish them.
  Carry existing assignments through any consolidation, update the declarations
  and generated consumers together, and compare decision quality before and
  after the change rather than adding more options by default.
- 🟢 🛠️ **Burn down raw enum literals in SQL.** `cubby/no-raw-enum-literal-in-sql`
  holds a shrink-only per-file baseline
  (`tools/oxlint/cubby/no-raw-enum-literal-in-sql-baseline.json`). Replace
  literals with the shared value constants file by file, lowering each count;
  check whether generic values (`other`, `unknown`) cause false positives
  worth excluding.
- 🟢 🛠️ **Move the image backfill onto the paced batch Run.**
  `backfillImageProcessing` keeps its own settings-row pause and progress;
  move it onto `runs/paced-batch.ts` beside the Suggestion sweep.
- ⏳ 🧪 **Re-weight the decision trial from paired data.** Every decision
  feature, Mail triage included, samples 50/50 Jev/Clef (`CLEF_TRAFFIC_SHARE`).
  Once reviewed history is readable over MCP, replay labeled Suggestions
  through both models (`suggest_fields` with `decisionModel`, per the
  decision-grading skill). Keep one global share unless a per-field gap
  exceeds the sample's noise.

- 🤔 🛠️ **Bound coordinator database concurrency.** Queue delivery concurrency
  alone cannot bound active purchase-agent/coordinator database work. Evaluate
  background limits against backlog/oldest age, pool waits and interactive
  latency before introducing runtime admission control.

Per-row household policies (SpendingCategory `productExpectation`) stay
columns; algorithms (allocation, reconciliation, fingerprints) stay code and
consume the declarations.

---

## AI & search

- 🤔 🧪 **Assess Agents SDK capabilities for Pi.** Pi now runs only Mail import
  and photo inventory on generic agent tools and mounted MCP actions. Adopt an
  [SDK capability](https://github.com/cloudflare/agents#features) only where it
  deletes existing lifecycle code (dispatch acknowledgement, settlement watch,
  stale-run expiry) or improves demonstrated behavior; do not add a second
  execution engine.

- 🟢 ✨ **Show estimated API spend avoided by subscription inference.** Retain
  each ChatGPT-plan call's catalog-priced API equivalent alongside its zero
  incremental API charge, then aggregate it through the shared AI usage and
  Run reports. Label the amount as estimated API spend avoided; preserve
  unknown prices as `null`, count cache/replay correctly, and keep subscription
  fees separate. Do not infer savings from missing usage or add a separate
  accounting workbench.

- 🟢 🛠️ **Use Claude subscriber API credits through AI Gateway BYOK.** Link an
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

- 🤔 🛠️ **One pricing source for the upstream cookbook pipeline.** Cubby usage
  pricing uses `models.dev` through `packages/shared/src/ai/pricing.ts`, but
  ingredient-parser's `cookbook` crate still builds its own model-price table
  (`cookbook/src/models.rs`, `cost.rs`, `Cargo.toml`). Decide how that pipeline
  receives catalog prices, then remove `llm_models_spider` upstream and update
  Cubby's pin. Preserve extraction estimates and token-cost accounting,
  including unknown prices as `null`; do not reintroduce a local fallback table.

- 🤔 ✨ **Deferred MCP agent capabilities.** Decide whether and how to expose
  operations marked `mcp: { omit: "deferred_capability" }` in
  `apps/web/src/contracts/`. The contracts own the operation inventory and
  omission reasons; [MCP exposure](agents/mcp.md#exposure) owns the policy.

- 🤔 🧪 **Trial `@cf/baai/bge-base-en-v1.5` via AI Gateway alongside OpenAI.**
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

- ⏳ 🛠️ **Trace the web Worker's AI calls into Sentry's Agents view.** Sentry
  wraps only `env.AI.run()`, not the `env.AI.gateway("cubby").run()` transport,
  and pi-ai calls use Cubby's shared gateway transport. Add `gen_ai.chat`
  spans at that transport when a web AI feature needs per-call debugging
  the Gateway cannot answer.

- 🔭 ✨ **Standing household agents.** A registrar for records, quartermaster for
  consumable shortfalls, and foreman for stale or blocked projects, approving
  durable writes.

- 🔭 ✨ **Ambient capture.** Voice memos, forwarded email, shared photos, and NFC
  entry points.

- 🔭 ✨ **Cubby to Home Assistant** (maintenance due, weekend work, tonight's
  meal for display and voice) and **Home Assistant to Cubby** (runtime,
  energy, fault, and weather signals into maintenance, evidence, and tasks).

---

## Dev tooling, tests & CI

- 🤔 🐛 **Diagnose PostgreSQL test teardown disconnects.** A hosted integration
  shard passed every assertion but failed on an unhandled `57P01` connection
  termination around `mail-import-run.integration.test.ts`. Establish the
  pool/database teardown lifecycle before changing error handling; preserve
  failures from unexpected disconnections.

- 🤔 🧪 **Measure post-change routing speed and quality.** The
  2026-10-08 metadata recheck (UTC 2026-09-08 through 2026-10-07, message
  snapshots deduplicated per parent session) recorded 44.6% of sessions
  delegating and 56.2% of tokens in subagents, mostly before the routing rule;
  the earlier 47% figure is a historical baseline.
  Repeat after a full post-change window using the same accounting and explicit
  latency/quality evidence; do not infer improvement from token shares alone.

- 🤔 🧪 **Capture exact runtime error shapes before broadening suppression.**
  Client-disconnected cancellation, missing update-result, opaque database
  failure, and pathological LIKE/GLOB reports need sanitized
  name/message/stack/route evidence and an event-shaped regression test before
  changing filters; never hide unrelated transport or query errors.

- 🤔 🧪 **Get iOS journeys to about 5 minutes.** Measure the first labeled
  journey run in the folded CI lanes (`docs/ci.md`), then cut its critical
  path (simulator boot, app build reuse, journey sharding) toward 5 minutes.
- ⏳ 🛠️ **Revisit folding Apple host tests into the simulator job.** Promote
  once a few post-fold CI runs show whether the separate host-test job still
  saves wall time against the simulator build it duplicates.

- 🤔 🧪 **Evaluate off-the-shelf OpenAPI generation.** The HTTP/Swift emitters
  under `scripts/generator/http-api/` might be replaceable by
  `swift-openapi-generator` and `openapi-typescript`; establish whether they
  cover the generated client contracts before replacing any emitter.

---

## Infra & deploy

- 🤔 🧪 **Check Google OAuth agentic-client requirements.** Verify current
  official requirements and whether any Cubby client calls Google Workspace
  MCP servers. The purchase-import Gmail client currently uses the Gmail REST
  API (`apps/web/src/server/purchase-import/gmail/client.ts`); distinguish that
  path before changing OAuth settings. Preserve existing scopes and member
  connections, and record any applicable rollout deadline in the owning runbook.

- 🤔 ✨ **Maintenance mode.** The `MAINTENANCE_MODE` Worker secret makes the web
  Worker answer 503 and skips the cron (`server/maintenance.ts`); purchase
  coordinator callbacks and tool effects now defer/refuse before DB/model
  access.
  Queues are paused by hand. Remaining:
  status in a Durable Object checked per request (503
  page except a new health route and the switch), by every queue consumer
  (`background-tasks/consume.ts`, `telemetry-queue.ts`, the purchase-agent
  consumer) and each Workflow-backed Run step (`server/workflow-runs/`), and by the agent's purchase-import run before each tool call (via a
  Run service); toggle from Settings and MCP. Decide first how
  consumers hold messages: a normally returning handler acks them, and
  `retry()` spends `max_retries: 3` with no dead-letter queue, so either call
  the Queues pause-delivery API from the toggle or retry with long delays.

- ⏳ ✨ **Failed Runs on the Problems page.** Routine scheduled Runs are hidden
  by default, so a failed scheduled pass is visible only in the Runs list.
  Promote if one goes unnoticed.

- ⏳ 🛠️ **TanStack Start observability.** Remove Cubby's wrapper when Start
  supplies named request/result/error events and exposes the dispatched
  operation id to a request hook (checked 2026-09-16: not yet).
  <https://tanstack.com/start/latest/docs/framework/react/guide/observability>

- 🟢 🛠️ **Resolve relation-filter shortcodes inside the list query.** A filter
  such as `growsPlantId` awaits a shortcode→id lookup before the page, count,
  and sums start (`repo/shortcode-resolver.ts`, `buildProductWhere`). Use a
  live-row subquery instead, keeping unknown and deleted codes matching
  nothing. The first query on a request also absorbs connection setup, so
  measure the gain rather than assuming the lookup's full duration.

- 🤔 🛠️ **Share product kit and category work across list queries.** One product
  page walks the kit graph four times (cost, valuation, sums, quality) and the
  category ancestors per row. Collapse those only where EXPLAIN on production
  data shows a win; keep unrounded valuation and signed expense sums, and do
  not merge everything into one relational query (its memory cost is
  documented in `repo/product/crud.ts`).

- 🤔 🐛 **Diagnose interactive production pool exhaustion.** Serial MCP
  `entity_read.get` requests for individual records can fail with SQLSTATE
  `58000`, "Timed out while waiting for an open slot in the pool." Inspect
  active connections, request lifetimes and pool limits before choosing a fix;
  verify that interactive reads recover without masking database diagnostics.

- 🤔 🛠️ **Summary `entity_read.get` without the detail read.** A summary get
  still runs the complete detail read (USDA, quality, ledger, breadcrumbs)
  before projecting to identity. Route it through `listFields` with an `ids`
  filter only after confirming each kind's list visibility matches `get`
  (default filters can hide rows a `get` returns).

- ⏳ 🛠️ **Production query-cost repair.** Promote the offender a fresh trace
  confirms; remeasure before restructuring. Unmeasured source-inspection
  candidates: project dashboard fanout, expense analytics aggregate scans,
  location valuation overlap, grouped-search expansion, and graph frontier
  batching. Whole-board and date-picker populations have deliberate completeness
  contracts. Capture revision, input population, SQL/pool waits, server CPU,
  bytes and usable client completion before choosing a change. Preserve signed
  credits, subtree/scope-root semantics, ranking and deterministic graph paths.

- 🟢 🛠️ **Pre-render the docs Mermaid diagrams.** Three diagrams pull ~108 client
  chunks (~4.9 MB raw, ~1.4 MB gzip, including the only >500 kB chunk, `elk`)
  through `app/docs/_components/MermaidDiagram.tsx`. Render them to SVG in
  `pnpm generate` (with a drift check) and delete the runtime dependency. Pick a
  renderer that runs without a browser first.

- 🤔 🛠️ **Trim duplicate and unused Worker dependencies (~0.4 MB gzip).**
  `agents` and the app resolve distinct MCP SDK versions
  (inspect the lockfile; dedupe only if the agent API still matches); better-auth's kysely adapter bundles introspectors for every
  dialect (~211 kB); `agents`' email feature pulls `mimetext` (~156 kB, stub it
  like `cfZodLocalesStub`); `vendor-identity` ships the full `tldts` suffix list
  (~259 kB). Check each with a `dist/server` size diff.

---

## Compatibility removal

[Breaking changes](../AGENTS.md#breaking-changes) is the rule; these are the
compatibility paths still live. Printed `P-`/`L-` QR labels and stored agent
transcript tool names (`app/purchases/agent-tool-names.ts`) are physical or
historical records and stay readable. `oauth_client.requirePKCE` and
`referenceId` are not legacy: the installed Better Auth declares and reads them.

- 🤔 🛠️ **Require statement-row positions.** `repo/statement-row.ts` keeps the v1
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
- 🧱 🛠️ **Re-extract flat-array cookbooks, then delete their fallback.** A few
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

- ✨ **Extend source-neutral statement import beyond CSV.** PDF and OFX with
  source text, date semantics, and account evidence preserved; AI-proposed
  mappings behind a visible preview; never infer kind from the amount's sign.

- ✨ **Bulk expense attribution and contribution-gap links.** Reuse the existing
  ledger editors and generic bulk path when shared-cost tagging or finding
  unresolved attribution becomes repetitive. Keep per-role replacement and
  one shared gap definition. Remaining slices and importer guidance:
  [ledger attribution follow-ups](plans/household-ledger-attribution-followups.md).

- ✨ **Person-to-person repayment discovery.** Promote once Ledger Transfers
  entered by hand become a chore. Sources: imported statement rows for payment
  apps never promoted to Financial Transactions, and Gmail "paid you" mail.
  Review-only; never resolve a counterparty automatically. Context:
  `docs/plans/household-ledger-attribution-followups.md`.

- ✨ **Retain non-Purchase financial Email evidence.** Card repayment and
  account-transfer alerts need a reviewed association to existing Financial
  Transactions without requiring a Purchase or creating Expense spend. Keep
  unmatched alerts actionable with their exact account and posted-leg gaps;
  avoid a misleading missing-Purchase problem after a financial-only review.
  Reuse reviewed financial associations and source retention where possible.

- ✨ **Project default beneficiaries.** Promote if shared-cost projects become
  frequent: explicit, then project default, then household, following
  `expense-inheritance.ts`. Needs schema and allocation-SQL changes.

- ✨ **Household finance analytics and cash-flow projection.** Category
  breakdowns, a funder-to-category Sankey, transfer-pair acceptance, and Phase 2
  projection remain deferred until household planning needs these views.
  Preserve the proposed contracts in
  [household finance synthesis](plans/household-finance-synthesis.md); net worth
  and retirement need a separate product/tenet decision before a time-series
  model is introduced.

- ✨ **Household balance sheet.** Promote when replacement planning, insurance,
  or cost-basis exports are actually needed. Generalize location valuation
  into replacement forecasts and cost-per-project analysis.

- ✨ **`imports_read.vendor_coverage` per account.** Promote when two members
  hold accounts at the same vendor.

- ✨ **`PurchaseLine` SKU annotation.** Promote when store SKU, quantity, or
  unit-price detail is genuinely wanted; `Expense` stays financial truth.

- ✨ **Purchase evidence references** when Gmail, Drive, or portal evidence
  must be queried beyond notes and attachments; **purchase
  replacement/exchange relations** when they need navigation, not notes.

- 🐛 **Per-edge breakdown for purchase merges.** Promote if `merge_entity`'s
  empty `moved` array on purchase is noticed; `foldChargeInto` does not count
  moved expenses and documents.

- ✨ **Multi-product Expense links.** Promote when one Expense needs several
  Products and `splitExpense` cannot truthfully split the money.

- ✨ **Returned-unit price advisory.** Promote when another stocked Product
  has a materially inflated derived price or returns become structurally
  distinguishable from sales; stay advisory.

- ✨ **Services-with-product advisory.** Promote when the first live row
  appears or an import repeatedly creates one; advisory, not a constraint.

- ✨ **Estimated-allocation analytics caveat.** Promote when
  materials-versus-labor analytics inform a real decision; disclose the
  allocation-basis portion without excluding it from total spend.

- 🧪 **Evaluate trade affinity in expense project suggestions.** Once the
  `expense.projectId` roster's per-project trade tallies
  (`server/ai/field-suggest/registry.ts`) have served real suggestions, compare
  accept/override rates on the `/ai` Usage tab and drop the tallies if they do not help.

- 🐛 **Shared-expense export re-import dedupe.** A Splitwise-style CSV has no
  row id, so provider ids derive from date + description + amount; promote if
  a re-export with edited descriptions is imported again.

### Inventory, products & locations

- ✨ **Persisted Collections and operational dashboard.** Smart starters
  evaluate manufacturer, tags, Location names, and historical Trades with
  editable OR rules. Promote when Collection tags need metadata, rename-safe
  identity, durable rules, or richer rules; migrate `collection:*` tags into
  durable records, and evaluate smart membership from a saved Product filter at
  read time. Extend the Trade predicate with "primary inferred Trade matches".

- ✨ **Repeat-purchase ranking.** Promote when enough Products have genuine
  repeated acquisitions.

- ✨ **Before-drywall spatial capture.** Promote immediately when construction
  is scheduled; define the smallest room/wall-indexed photo packet before
  walls close.

- ✨ **Digital twin and spatial memory.** Promote when a specific building
  knowledge retrieval need exceeds Location notes and attachments. Attach
  shutoffs, breaker maps, paint, and hidden utilities to the location tree.

- 🛠️ **`location.tags` redundant-token pruning.** Locations hold only
  `collection:*` tags today.

### Ingredients, recipes & nutrition

- ✨ **Durable shopping list.** Server-backed manual items (milk, paper towels)
  and checked state across date ranges and devices, independent of inventory.
  Blocks sending meal-suggestion shortfalls to the list and shopping pack
  rounding.

- ✨ **Grocery cost basis.** Allow `productId` on `discount` rows (Whole Foods
  promos, Buy-Again are per line) and let `productQuantity` carry `{value,
  unit}` for measured lines (`0.5 lb @ $4/lb`), folding both into derived cost
  basis without changing `SUM(Expense.cost)`. Promote when per-serving or
  per-unit cost numbers are actually used.

- ✨ **Recurring meals, meal templates, and meal nutrition goals.** Each its own
  slice; goals would compare planned nutrition against explicit targets.

### Tasks, projects & garden

- ✨ **Project materials and shortfalls.** A project-material edge with
  quantity, free-text unit, optional Product, and durable/consumable semantics
  (see `Product.kind`); derive have/need/buy through the availability engine
  without reservations or automatic decrement. Promote when a concrete
  project needs a have/need/buy worklist.

- ✨ **House timeline.** Promote when project journals or before/after retrieval
  need a chronological view beyond current timelines. Generalize `GardenEntry`
  into dated Location, Planting, and Project journal entries on
  `entity.timeline`, then project milestones, photo comparisons,
  and an annual view.

- ✨ **Heirloom outputs.** Promote when preparing an actual handoff or archive:
  a future-owner house manual, project yearbooks, and a durable export format.

- ✨ **Project locations as Locations.** `Project.locations` holds a few
  free-text street addresses, mostly former residences.

- ✨ **Recurring maintenance tasks.** Every-N-weeks/months; completing an
  instance creates the next through one idempotent transactional rule.

- ✨ **Hierarchical Project/Task parent pickers.** Rosters are shallow; revisit
  on deep nesting.

### Native app

- ✨ **Accept recipe links from the iOS Share Sheet.**

### Web UI

- ✨ **Saved user-created views.** Named filter/sort sets via the versioned
  external-state pattern, beside manifest `presentation.list.views`.

---

## Dormant schema — revisit

Built but barely used. Each stays until someone decides to use or remove it;
Recheck current readers and usage before retiring any storage.

- **Historical Run machinery.** `ImportPreparedOrder` and `ImportPreparedLine`
  are active contracts. Audit legacy approval/control storage only after
  checking current readers.
- **Review queues.** `SuggestionDismissal`, `ProductMatchCandidate`,
  `ImageDescriptionCorrection`, `OrderMailCandidateDecision`,
  `MerchantVendorRule`. `MailboxCursor` is active in
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

- **Project existing images into search.** Existing images still need search coverage verification. Runs entirely server-side (projection, then queued
  embeddings through AI Gateway). Best after automatic description is on, so
  documents carry description text; call `maintenance.backfillImageSearch`
  until it reports `stopped: "complete"`.

- **Finish image provenance rollout on existing photos.** Verify provenance coverage before the sweep. Run `classifyImageProvenance` in dry-run mode, review,
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
  (`/recommendations/workbench?kind=product-match`). Walkthrough:
  [wardrobe import](guide/wardrobe-import.md); second-member onboarding:
  [photo-inventory pilot](runbooks/photo-inventory-pilot.md).
