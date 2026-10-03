# Cubby — Work List

The canonical backlog, grouped by area. Items are not ranked. Each item starts
with one status marker naming its next blocker:

| Marker | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| 🟢     | Ready: decided, no schema change                          |
| 🧱     | Ready once schema, migration, or compatibility is planned |
| 🤔     | Needs a decision, investigation, or evidence              |
| ⏳     | Waiting on a named trigger; promote only when it fires    |
| 🔭     | Long-term direction                                       |

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

- 🟢 **Receiving an already-photographed purchase.** Keep import stock-neutral.
  Surface existing photo inventory and pending Product matches before offering
  receive; resolve identity first, then explicitly confirm whether additional
  units arrived and their quantity. Never treat a merge or later purchase
  evidence as another receipt of already-counted stock. Contract:
  [product identity](product-identity-journey.md).

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

- 🟢 **Manual purchase lifecycle.** Account-sync runs handle several listed
  orders, defer one ambiguous order for review without blocking the rest, and
  carry unfinished orders into a restart. Remaining: start a run from a
  selected set of mail or charge candidates (today mail is one run per message
  and hunts join the account run), with each candidate's terminal outcome
  recorded. Reuse the bounded prepare/commit and approval paths in
  [purchase import](../.claude/skills/purchase-import/SKILL.md).

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

- 🧱 **Cross-vendor manufacturer identifiers.** Add manufacturer-scoped
  part/style identity distinct from retailer SKU, with contract/generation
  compatibility planned across clients. Only identifiers proven to name an
  exact variant may resolve identity in the unique external-ID namespace;
  shared family/style numbers remain descriptive candidate-ranking evidence
  requiring size/color/model corroboration. Do not add a Product-family entity
  or merge automatically (`packages/schemas/src/external-id.ts`).

- 🤔 **Run the purchase decision evaluation.** A 12-case synthetic corpus and
  scorer (correct, unsafe, reviewable miss; latency, tokens, cost) exist behind
  `pnpm --dir apps/web eval:purchase-decisions` (opt-in, billed). Run it on
  candidate coordinator models before changing matching or purchase-run model
  routing; purchase runs stay on Sol until it does. Scripted Flue scenarios
  prove orchestration, not model judgment.

---

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

- 🧱 **Consumable vs durable as a Product attribute.** Add optional
  `Product.kind: consumable | durable`, independent of the choice to count
  stock (`stockTracked`). Use kind for useful worklist filters and contextual
  import project suggestions: routine supplies suggest Household, project
  materials use order/project evidence, and explicit choices win. Leave kind
  unset when uncertain, with no completeness penalty or classification wizard;
  do not rewrite existing Expenses. Plan schema and generated-client
  compatibility before adding the field.

- 🧱 **Record historical acquisitions with unknown cost and date.** Record a
  known acquired quantity through the existing Expense path with `cost: null`
  and an absent date when unknown; never invent quantity, price, or date, and
  never receive stock as a side effect. The current date contract allows an
  absent date only for zero cost: plan its cross-client compatibility change
  and distinguish undated history in date-based reports
  (`packages/schemas/src/expense-fields.ts`,
  `repo/product/quantity-ledger.ts`). This
  addresses negative expected quantities from exits whose earlier acquisition
  is missing; filling known acquisition quantities remains an operational pass.

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
  task still needs the web. Concrete gap: `NativePresentationCoverage.heroAction`
  marks add-to-inventory, bulk edit, delete, discard, mark-purchased,
  record-sale, and set-status unsupported; port recurring verbs first,
  preserving web confirmations and impact previews. Add editor focus order or
  comprehensive sheet lifecycle only on demonstrated friction. Owners:
  `apps/apple/App/Shared`, generated `EntityCatalog`.

- ⏳ **Native specialized-renderer editors.** Promote per field as a native
  workflow needs it: product `unitMappings`/`labelNutrition` (read-only today),
  financialAccount `sourceAliases`, financialTransaction `sourceRefs`, and
  every `structured-field`. They show "Additional fields are available on
  web". On web, `cardNumbers` has no editor (MCP-only history).

- ⏳ **Retire native-owned web fieldwork and PWA installation.** After native
  parity ships and passes real-device validation, remove web barcode/QR
  controls, `/scan`, the sweep UI, superseded recount and location photo-pass
  routes, and PWA assets. Handle unfinished browser-local passes and old links
  first; keep record links, photo upload, and the scan/reconcile APIs.

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

- ⏳ **Expose recipebridge conversion, needs, costing, and nutrition via
  cubby-ffi** alongside the first native screen that scales a recipe or prices
  a meal. Until then the FFI stays `parse_ingredient`, `size_unit_aliases`,
  `normalize_isbn`, `scan_code_gtin14`.

---

## Web UI

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

- 🟢 **Complete MCP SDK v2 adoption.** After restoring ChatGPT connectivity,
  migrate remaining legacy transport/test helpers and retire obsolete v1
  compatibility code. Preserve tool contracts, purchase-agent authorization,
  MCP Apps, and Cloudflare-safe validation. Keep legacy protocol support until
  Flue supports modern version negotiation; its current MCP client defaults
  to legacy requests without exposing a negotiation option.

- 🤔 **One FROM context per entity list.** Each list repo pairs a relational
  `findMany` (root aliased) with an unaliased `$count`, so a predicate
  referencing the outer row compiles on one leg and fails on the other — six
  shipped occurrences (#456, #462, #481, #762, #785, CUBBY-11R), guarded by
  `server/entity-kernel/list-smoke.integration.test.ts`. Decide: plain-select
  rows with explicit joins, one shared `alias(table, name)`, or Drizzle
  relations v2.

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

## AI & search

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
  and TanStack AI adapters bypass provider integrations. Add a `@tanstack/ai`
  `ChatMiddleware` next to `ai-gateway-usage.ts` opening a `gen_ai.chat` span
  when a web AI feature needs per-call debugging the Gateway cannot answer.

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

- 🤔 **Measure the delegate-less routing change.** Around 2026-10-06,
  re-measure 30 days of Claude session transcripts against the baseline in
  [model routing](agents/model-routing.md#delegate-or-not): share of sessions
  spawning subagents (about half), subagent share of context tokens (47%), and
  subagent output on Opus/Fable. Keep the rule if shares fell without slower or
  lower-quality sessions.

- 🤔 **Spike Drizzle 1.0 RC for test factories.** `drizzle-orm@1.0` RC
  exports `./zod` and `drizzle-seed` generates seeded rows; installed is
  0.45.2. `server/db/create-shape-drift.unit.test.ts` records a decision
  against drizzle-zod create shapes, so adoption reverses it; weigh against
  `entity-definitions`. Do not bump drizzle outside the spike.

- 🤔 **Offer a Docker path for local development.** `pnpm dev` and local test
  services need macOS with Apple `container` (`scripts/lib/apple-container.ts`).
  Decide whether a Docker backend is worth supporting for non-macOS
  contributors and agent sandboxes.

- 🤔 **Narrow the `e2e` Nx target's inputs, then cache it.** `nx affected`
  treats all of `apps/web/src/**` as e2e input and the target is uncached.
  `tests/e2e/spec-areas.ts` maps specs to what they exercise for
  `test:e2e:affected`; decide whether a cache hit on an unchanged tree is
  acceptable evidence and whether to reuse that manifest.

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
  consumer), and by the Flue purchase-import run before each tool call (via a
  `PurchaseImportService` RPC); toggle from Settings and MCP. Decide first how
  consumers hold messages: a normally returning handler acks them, and
  `retry()` spends `max_retries: 3` with no dead-letter queue, so either call
  the Queues pause-delivery API from the toggle or retry with long delays.

- 🤔 **Evaluate Cloudflare Workflows across durable background work.** Start
  with vendor Gmail discovery: one instance per Run, bounded pages, a
  persisted cursor, and timed waits on AI Gateway 429s. Define how a Run
  exposes instance, step, retry time, attempts, and failure chain through the
  generic detail view. Test version changes, cancellation, duplicate delivery,
  and exhaustion before migrating; keep the queue path until a Workflow can
  recover a paused Run. Then compare image processing, purchase import,
  validation/enrichment, and backfills (search-index repair is the reference).
  Device-local work (library scan, classification sweep, sighting backfill)
  can post into `runProjection` as a transport addition. See
  `docs/infrastructure.md`.

- ⏳ **TanStack Start observability.** Remove Cubby's wrapper when Start
  supplies named request/result/error events and exposes the dispatched
  operation id to a request hook (checked 2026-09-16: not yet).
  <https://tanstack.com/start/latest/docs/framework/react/guide/observability>

- ⏳ **Production query-cost repair.** Promote the specific offender a fresh
  production trace confirms; remeasure before restructuring counters.

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

- **Attribute Flue provider calls to their run.** The Flue provider
  (`apps/purchase-agent/src/cubby-ai-provider.ts`) still tags gateway metadata
  with `jobKind: "purchase_import_run"`; send the run id once Flue exposes the
  current run to module-scope providers.

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
