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
  extractor result, so purchase runs stay on Sol. Scripted agent scenarios
  prove orchestration, not model judgment.
- 🔭 **Grow the purchase evals from member dismissals.** A dismissed mail
  link, a dismissed import finding, or a cancelled automatic import is a
  labeled mistake. A scheduled worker skill would read recent ones and draft
  synthetic look-alike cases for `purchase-decision-eval.fixtures.ts` (never
  real household data), opening a PR for review. Dismiss stays one tap with
  no reason field, and nothing tunes itself.

---

## Import pipeline architecture

How browser, mail, file, and photo imports, account syncs, and enrichment
should work end to end. Area-specific items stay in their sections; these
change the shape of the pipeline. The browser bridge contract is in
[infrastructure](infrastructure.md#browser-bridge).

- 🔭 **Code drives the sync; the model only judges.** An account sync is a
  fixed loop: open order history, list orders, capture each, extract, write,
  page on. Today the coordinator model drives every step, so a stuck capture
  costs model time on every retry (one sync spent minutes of model time over
  hours, re-issuing the same capture). Make the walk a server workflow
  (`readBrowserCommandResult` already owns recovery) and call the model only
  at judgment points: reading an order, matching Products, choosing review.
  The purchase decision evaluation gates the switch.

- 🟢 **Server-enforced run budgets.** `browserRecovery` already caps one
  command at one retry, but the coordinator then issues the same logical step
  under a new operation id, so a run loops for hours. Budget across the run
  instead: repeated failures of the same step (same target and outcome) and
  total active time, then stop for review with the last observation as the
  reason. Time paused for the member (sign-in, a permission, the Mac offline)
  does not count; those pauses already expire on their own.

- 🧱 **Vendor capture profiles.** Record per Vendor what a sync learns once:
  the order-history URL, sign-in host, extra allowed hosts (for example a
  hosted customer-account domain), and pagination shape, so later runs go
  straight there instead of guessing from the home page. Learned values
  are proposed for review, never silently trusted.

- 🤔 **Sign-in detection beyond password fields.** `derivePageCapture`
  flags sign-in only when the page has a password input; email-code logins and
  redirects to a hosted sign-in domain read as an ordinary page. Combine a
  model classification of the page with code checks (a host change, a known
  sign-in path) before pausing for sign-in.

- 🤔 **Check hosted customer accounts.** Verify whether a vendor's order
  history lives on a hosted account domain outside its `browserDomains`
  (Shopify's newer customer accounts do); if so, the capture can never reach
  it. This feeds vendor capture profiles.

- 🟢 **Tell the member when a run needs them.** A pause for sign-in,
  Screen Recording, or Chrome's Apple Events setting should post a macOS
  notification naming the fix, with an action that raises Cubby's window.
  Today the reason appears only on the Runs page and in Mac Settings.

- 🟢 **Re-read stored pages after a derivation change.** Captured DOMs are
  kept as `RunEvidence` and stamped with `PAGE_DERIVATION_REVISION`, but the
  derived page is cached on its operation row (`materializeCapture`) and
  later reads return the cache. A maintenance job should re-derive pages at
  an older revision, replace the cached page and evidence metadata, and
  report which committed imports or enrichments the new reading would change
  (re-running them stays a member decision). Done when no cached page is
  below the current revision.

- 🔭 **One order document for every source.** Browser captures, order mail,
  uploaded files, and receipt photos each reach extraction differently.
  Normalize each source into one order-document shape (text, links, images,
  structured identifiers, provenance) feeding one extractor and writer, so a
  fix to one path improves every path.

- 🤔 **Live browser E2E on macOS.** No automated test drives the Mac app and a
  real Chrome together, so the redirect-readiness bug reached production. The
  fixture-retailer scenario (`tooling/mac-browser-import-scenario.ts`) is
  local-only: it needs the project's Developer ID identity
  (`mac-fixture-identity.ts`) and persistent Automation and Screen Recording
  grants, which a hosted macOS runner lacks. Decide between a self-hosted Mac
  runner and a harness that drops those prerequisites, then run it nightly
  with a redirecting order page, an email-code sign-in, and a slow
  navigation, leaving the E2E artifact described in
  [test tiers](agents/validation-tests.md).

- 🟢 **Vendor-platform fixtures for page reading.** Keep synthetic DOM
  fixtures modeled on common storefront platforms (Shopify, WooCommerce,
  BigCommerce, a marketplace) and assert what `derivePageCapture` and the
  extractor read from each, including variant groups and truncation.

- 🟢 **One-command Mac app install.** Build, sign, install to
  `/Applications`, and relaunch with one command, so the installed app
  matches `MINIMUM_APPLE_CLIENT_VERSION` and a protocol release is one step.
  Today the household app runs from a Debug build folder.

- 🟢 **Account status from the server.** Mac Settings shows "Connected" from
  its own socket state. Show the server's view per account: browser sync on,
  socket connected, the current run and its last step, and the last
  successful sync.

- 🟢 **Agent routes on generated contracts.** Move the remaining hand-written
  `/api/import/agent/*` routes the Mac calls (accounts, debug events) onto RPC
  contracts with generated Swift, as account sync is moving.

- 🟢 **Keep debug events out of run operations.** Mac debug events are stored
  as `__debug_event` operation rows, so one run's status read lists dozens of
  them among its real steps. Give them their own bounded stream and keep run
  operations to real work.

- 🟢 **Show each run's cost and time.** The Runs page should show model time,
  token cost, browser time, and retries per run, so an expensive or looping
  run is visible at a glance.

## Runs, enrichment & browser capture

Runs are the household's unattended work: account syncs, mail passes, charge
searches, Product enrichment, photo inventory. Today each is a separate Run
linked only by restarts (`predecessorRunId`) and the records it wrote. The
Runs list and `imports_read.run_status` read one shared projection
(`server/repo/activity.ts`).

- 🧱 **Run lineage.** Keep Run as the one unit of work; a Job or Step table
  would duplicate status, actor, and the one-active-run-per-account fence,
  and the pending work already lives in `RunOrderCandidate`, `ImportHunt`,
  and open Products. Add `parentRunId` (the run whose work caused this one,
  apart from `predecessorRunId`, the same work's next attempt), a `cause`
  enum, and `attempt` to the Run declaration, and write them at every
  starter. Give the discovery pass its own Run so every automatic child has
  a parent, and group the Runs list by root. Historical rows stay null; do
  not backfill lineage from AuditLog. Enum values reach production before
  any writer uses them (two deploys).

- 🧱 **An honest purpose for mail imports.** Order-mail imports are
  vendor-less `account_sync` Runs told apart only by `input.kind`. Add a
  `mail_import` purpose and relabel existing rows, updating the enrichment
  sweep's import-provenance join, the run cap, and skill text that names
  purposes in the same change. Production data change: confirm first.

- 🟢 **Chain enrichment from run completion, on one path.** A finished
  mail import or account sync triggers the enrichment sweep for its account
  (after commit, never inside the finish transaction), replacing the sweep's
  wait on an occupied account. Delete the inline enrichment of image-less
  Products inside an account-sync claim (`run-service.ts`), so the sweep is
  the only enrichment path. Only import completions trigger, so enrichment
  cannot re-trigger itself.

- 🤔 **Route vendors by their fetch-first record.** Enrichment captures try
  a server fetch first and record each refusal as a run progress line
  (`readPageOnServer`). Tally refusals per vendor before skipping the fetch
  for vendors that always refuse, or routing any vendor fetch-only.

- 🟢 **Enrich the variant that was bought.** Seed and Shopify pages are often
  variant groups, which the single-Product proof rule rightly skips. Open
  the purchased variant (`?variant=` matched by SKU or price) and read its
  per-variant barcode (Shopify's `.js` product JSON exposes them).

- 🟢 **Sync order history before enriching mail-imported orders.** Order mail
  rarely names the variant; the vendor's order page does. Enrichment
  targets carry the order line (`sourceKind: order_line`) and its parent
  run's evidence, and a commit whose variant disagrees with the ordered line
  is refused.

- 🤔 **Link enriched seeds to Plants.** Seed Products could set `growsPlantId`
  and carry plant facts (days to maturity, spacing) from the vendor page.
  Needs a decision on which facts live on Plant versus Product.

- 🤔 **Provenance for already-filled fields.** Enrichment fills only empty
  fields, so a verified value matching an existing one gains no provenance.
  Decide whether a matching verified value records its source.

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

- 🟢 **Captured pages beside their results.** Add a bounded capture filmstrip
  to the run console and open a selected page beside the order lines or Product
  facts derived from it. Show capture time, source URL, and the changes it
  supports, so a suspicious result can be checked without hunting through logs.
  Reuse RunEvidence; distinguish captured evidence from the current preview.

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

- 🟢 **Stop and restart runs over MCP.** `imports_read.run_status` reads a
  Run; offer stop, retry, and restart beside it. Approve and reject stay
  human (`run.control` is omitted from MCP as `human_approval`), so this is a
  narrower operation, not that one exposed.

- 🤔 **Model routing for capture.** Use Jev for constrained choices (variant
  matching), Luna for reading unstructured pages, and Sol only to
  orchestrate. Measure on the purchase decision evaluation before switching.

- 🟢 **Generate native activity kind titles.** The Apple `kind.title` and
  `kind.symbol` extensions restate `ACTIVITY_KIND_LABEL`; generate them.

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

- ⏳ **USDA duplicate collapsing.** Promote if repeated UPC versions return to
  search pages; reuse `dedupeUsdaFoodsByUpc` in the MCP handler.

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

- 🤔 **Keep a focused structured-editor input clear of the keyboard.**
  `StructuredValueControl` draws a whole array row (an external ID's source,
  kind, id, URL) inside one Form row, so keyboard avoidance scrolls that tall
  cell and a lower input stays under the prediction bar (measured: zero
  clearance on the iPhone simulator; the Tester Army agent could not reach the
  input it had focused). Give each input its own row or scroll the focused
  input itself; verify with the external-ID journey. Owner:
  `App/Shared/Editors/StructuredValueEditor.swift`.

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

- 🟢 **Classification-declared field policies: remaining classifications.**
  A classification decides whether a field or link is expected, and whether
  it is allowed at all: a SpendingCategory with `productExpectation:
  not_allowed` (Restaurants) means an Expense neither expects nor may link a
  Product (strict refusal on every write path; #1685 and #1682). Decided
  shape: fixed classifications declare policies in the entity manifest
  (`capabilities.classificationPolicies`, keyed by classifier value);
  household-editable ones keep per-row columns; one registry and evaluator
  (`@cubby/schemas/classification-field-policy`) reads both, in one vocabulary
  (`required | not_expected | unknown | not_allowed`). Shipped: that registry,
  with SpendingCategory `productExpectation` registered, and the
  ProductCategory `feature` slice — food-only `ingredientId`/`fdc_id`,
  books-only ISBN, required `model` — read by category admission, the
  `product_model` gap, and Jev targets ([entities](entities.md#classification-field-policies)).
  Remaining, decided: move `productExpectation` enforcement
  (`validateProductPolicy`, `expenseProductForbiddenSql`) onto
  `classificationPolicySql`; the project-resource capability and
  garden-source refusal in
  `productCategoryFeatureCapabilities`/`assertProductCategoryChange`;
  SpendingCategory `evidenceExpectation` with Vendor/Purchase overrides
  (`repo/purchase-evidence-policy.ts`); Location type; Task/Project trade.

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

Classification knowledge — enum vocabularies and what each value means,
the policies a value implies, the inheritance chains that resolve an
effective value, and the Jev prompts that suggest one — is spread across
entity declarations, hand SQL, and the Jev registry. Move each into one
declaration that the generator, the field-policy evaluator, and Jev all read.
Steps in order; each is independently shippable.

- 🟢 **Derive Jev suggestion specs from the manifest.** The Jev registry
  (`server/ai/field-suggest/registry.ts`) imports the shared enum value arrays
  but restates each value's label and description by hand in every spec
  (`expectationSpec`, `productExpectationSpec`, and the other enum specs), so
  a label or meaning lives in two places. Each enum field declares its options
  once — value, label, meaning — and only the prompt guidance stays
  hand-written, as `suggest: { rules }` on the field declaration; the registry
  becomes generated from those declarations.
- 🟢 **Finish the field-policy migration.** The remaining items of
  **Classification-declared field policies** (Entity platform & data model):
  move `not_allowed` enforcement (`validateProductPolicy`,
  `expenseProductForbiddenSql`) and the delivery receiving gate onto
  `classificationPolicySql`, then declare SpendingCategory
  `evidenceExpectation`, Location type, and trade.
- 🤔 **Declare effective-value inheritance chains.** "Expense category =
  override → vendor food context → product mapping (category ancestors) →
  Purchase default → Vendor default" lives in hand SQL
  (`repo/expense-category-resolution.ts`), as do trade and project
  inheritance. Declare each chain and generate the resolution SQL, the
  "inherited from" explanation, and the set of Expenses a change can reach —
  the reach scope the reviewed classification preview hand-writes once #1712
  lands. Generated SQL must match hand-tuned performance; #1712's preview
  equivalence and scale tests are the guard. Decide the declaration shape
  first.
- 🟢 **Lint raw enum literals in SQL.** Once vocabularies are generated
  constants, flag string literals such as `'not_allowed'` or `'principal'`
  inside `sql` templates so a typo or stale value fails at build time instead
  of matching nothing.
- 🤔 **Review every Jev proposal on one page.** Jev suggestions are computed
  per record and never stored, so a wrong or missing classification surfaces
  only on a record someone opens. One generic page lists every manifest
  `control.suggest` target across entities as a correction (current ≠
  proposed) or an addition (blank), with current → proposed, reasoning, and
  probability. Accept one or a selection through the normal update or the
  reviewed finance apply, which previews Expense reach. Reject into
  `SuggestionDismissal` (`server/repo/suggestion-dismissal.ts`, dormant), keyed
  on target and proposed value, so the same proposal never resurfaces;
  `features/ai/suggestion-review.tsx` dismissals last one visit. Proposals
  come from the **Suggestion sweep primitive** (AI & search); the page derives
  its targets after **Derive Jev suggestion specs from the manifest**. Decide
  whether proposals persist as Run output or recompute per bounded scan,
  whether low-probability proposals stay visible, and what invalidates a
  dismissal.

Per-row household policies (SpendingCategory `productExpectation`) stay
columns; algorithms (allocation, reconciliation, fingerprints) stay code and
consume the declarations.

---

## AI & search

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
  - Order mail: `vendor.orderMail`, `vendor.searchOrderMail`,
    `vendor.orderMailSearchStatus`, `vendor.importOrderMail`,
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

- 🤔 **Suggestion sweep primitive.** One run shape for bulk suggestion passes:
  record each suggestion (target, branch-rolled confidence, runner-up), apply
  only high-confidence changes, queue the rest for review, with progress and
  pause. Consumers: product re-categorization first (run after automatic
  description, since the basis is mostly text until then), then reviewing
  suggestions across a full filtered list instead of opened pages only.
  Decide where the run lives: a `Run` purpose, the activity `runProjection`,
  or a primitive shared with `backfillImageProcessing`. Measured: about $0.10
  per 1,000 Jev calls at a 2.3k-token roster; ~6% throttling near 600/min, so
  pace at a few hundred per minute. The response cache keys on taxonomy
  revision, so any category edit invalidates a completed sweep.

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

- 🤔 **Stop the simulator build from dirtying the checkout.** Every
  `test:e2e:sim` lane's Xcode build rewrites the tracked
  `apps/apple/CubbyKit/Package.resolved` (adding the app-only Nuke pin), so
  each native E2E bundle records `dirty: true` and is not replayable evidence.
  Give the app project its own resolved file or build with a resolution that
  leaves CubbyKit's untouched. Owner: `apps/apple/project.yml`,
  `apps/web/tooling/sim-e2e.ts`.

- 🤔 **Make Tester Army `--replay` able to hit.** Two consecutive warm web
  runs of `product-rename` (2026-10-04) both reported `replayed 0, missed 1`
  and used the model each time. Each run seeds fresh records, so on-screen
  shortcodes differ; find which observed state the SDK keys the cache on and
  either stabilize it or drop the flag. Owner: `apps/web/tooling/tester-army/`.

- 🤔 **Measure the delegate-less routing change.** Around 2026-10-06,
  re-measure 30 days of Claude session transcripts against the baseline in
  [model routing](agents/model-routing.md#delegate-or-not): share of sessions
  spawning subagents (about half), subagent share of context tokens (47%), and
  subagent output on Opus/Fable. Keep the rule if shares fell without slower or
  lower-quality sessions.

- 🤔 **Offer a Docker path for local development.** `pnpm dev` and local test
  services need macOS with Apple `container` (`scripts/lib/apple-container.ts`).
  Decide whether a Docker backend is worth supporting for non-macOS
  contributors and agent sandboxes.

- 🤔 **Capture exact runtime error shapes before broadening suppression.**
  Client-disconnected cancellation, missing update-result, opaque database
  failure, and pathological LIKE/GLOB reports need sanitized
  name/message/stack/route evidence and an event-shaped regression test before
  changing filters; never hide unrelated transport or query errors.

- ⏳ **Fixture-backed web preview route.** A dev-only route rendering loading,
  error, and edge states from schema-backed fixtures; the production bundle
  excludes faker and the route. Promote when driving states through full app
  flows repeatedly slows iteration.

- ⏳ **E2E against the HMR session.** An optional Playwright lane reusing the
  persistent `pnpm dev` workerd origin; needs isolated fixtures, cleanup, and
  sanitized replay artifacts before replacing a local lane. CI keeps the
  exact-head merge gate.

- ⏳ **Natural CI evidence.** Revisit sharding only when exact-head runs show
  a repeatable tail imbalance; no duration databases or custom sequencers.

---

## Infra & deploy

- 🤔 **Maintenance mode.** The `MAINTENANCE_MODE` Worker secret makes the web
  Worker answer 503 and skips the cron (`server/maintenance.ts`); queues are
  paused by hand. Wanted: status in a Durable Object checked per request (503
  page except a new health route and the switch), by every queue consumer
  (`background-tasks/consume.ts`, `telemetry-queue.ts`, the purchase-agent
  consumer) and each Workflow-backed Run step (`server/workflow-runs/`), and by the agent's purchase-import run before each tool call (via a
  Run service); toggle from Settings and MCP. Decide first how
  consumers hold messages: a normally returning handler acks them, and
  `retry()` spends `max_retries: 3` with no dead-letter queue, so either call
  the Queues pause-delivery API from the toggle or retry with long delays.

- 🤔 **Move backfills onto Workflow-backed Runs.** Vendor mail search and
  scheduled Gmail discovery run as Workflow-backed Runs (see
  `docs/infrastructure.md#workflow-backed-runs`); search-index repair is the
  other Workflow. Long, page-oriented backfills are the next fit: give each a
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

- 🤔 **Faster `usda-api` reads.** A lookup ran its version check and index
  lookup as sequential D1 calls (~60 ms each) plus ~150 ms outside the
  handler. Try D1 read replication with request-scoped Sessions and a warmer
  version cache (`apps/usda-api/src/data/`); benchmark against the current
  placement before adopting it.

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

- 🤔 **Move `recipebridge` WASM out of the web Worker.** The 3.4 MB module is
  ~23% of every deploy's gzip upload but changes only with Rust edits. Callers:
  `server/utils/scraper.ts`, `repo/import-recipe-convert.ts`,
  `services/availability.service.ts`, `repo/problems/reparse.ts`. A
  service-bound Worker deployed only on Rust changes removes it, at the cost of
  an RPC hop and a second deploy unit. First measure whether workerd compiles
  it at startup (part of the 179 ms) or lazily.

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

- **Run and import machinery.** `RunApproval`, `RunControlEvent`, `RunEvidence`,
  `RunOrderCandidate`, `ImportHunt` (all 0); `ImportPreparedOrder` /
  `ImportPreparedLine` (1 / 5). Recheck use against
  [import and resume orders](#import-and-resume-orders-reliably) before deciding
  whether to use or remove these tables.
- **Review queues.** `SuggestionDismissal`, `ProductMatchCandidate`,
  `ImageDescriptionCorrection`, `OrderMailCandidateDecision`,
  `MerchantVendorRule`, `MailboxCursor` (all 0). Recheck against Product match
  recall, collision review, and [purchase corrections](#review-and-apply-corrections);
  an empty queue alone does not establish that its workflow is unnecessary.
- **Always-null columns.** `Plant.daysFrom*` and `Plant.breeding`,
  `Planting.outcome`, `Vendor.returnWindowDays` and `Vendor.orderEvidence`,
  Image `sourcePageUrl`, `sourceAssetUrl`, `sourceName`,
  `Run.historyCursorUrl` / `dispatchError` / `deviceId`, `Task.sortOrder`,
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
