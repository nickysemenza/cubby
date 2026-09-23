# Cubby — Work List

The canonical backlog, organized by the kind of work needed next rather than
priority. Items are not ranked within or across sections. Choose among sections
based on the work that fits the moment.

**Easy fixes** are contained, decision-ready changes without schema work.
**Ready projects** are larger decision-ready implementations without schema
changes. **Requires database changes** is reserved for work that needs schema,
migration, or compatibility planning. **Requires thought or evidence** holds
unresolved decisions, investigations, external triggers, and long-term
directions. **Next pass** holds the follow-ups deferred from the last
large refactor. **Deferred: deploy surface** holds work that changes what gets
deployed. **Operational passes** are household data work, not software
projects.

Each item lives in one primary section based on its next blocker: an unresolved
decision or missing evidence takes precedence over an eventual database change.

Keep entries concise and outcome-oriented. Record only constraints that would
change selection or implementation, with a pointer to the code or focused doc
that owns the full contract. Shipped and superseded work leaves this file; git
history is the archive. Permanent product constraints live in the
[Tenets](../README.md#tenets), not in rejected-idea essays here.

---

## Easy fixes

- **Name field-resolution sources on the server.** `FieldResolution.sourceEntity`
  carries only `{ entityType, entityId }`, so every provenance caption and
  field-explanation link (`EntityInlineLinkById` → `EntityReferenceLink`)
  fetches the source's full detail just to read its `titleField` and cover,
  and shows the bare shortcode until that lands. The builders already hold
  the rows (`server/repo/task-project-inheritance.ts` loads project names,
  `server/repo/expense/helpers.ts` has `purchaseRow`,
  `server/repo/expense-inheritance.ts`, `server/repo/product-category.ts`):
  add a nullable `name` to `fieldResolutionSourceSchema` and pass it through
  as `EntityReferenceLink`'s `name`, keeping the fetch only as a fallback.
  Also removes the per-row detail fetch the AI usage page now makes for
  project/task/purchase entries.

- **CalDAV feed dirty-mark can fail silently.** The dirty-mark in
  `server/calendar/client.ts` (annotated `SILENT:`, guarded by the
  `cubby/no-swallowed-catch` rule) runs after the response is committed, so a
  failure leaves the feed stale until the next successful write. Move it onto
  the write's own transaction or a retried queue message. (Product mutations
  now carry `sideEffects.warnings` for best-effort failures if a caller-visible
  channel is wanted instead.)

- **Canvas conformance follow-ups.** The generic pages now render the
  canvas (<https://claude.ai/artifact/A45j5qz24RjRK6KzKmKLWL>): one 44px
  workbench band with declared-filter chips and `Actions ▾`, plate verbs,
  inline anchor index, counted relation sections with header verbs and
  sentence + action empty states, sentence-case labels and facts, the phone
  edit sheet with header actions, and phone rows as the manifest projection.
  What the pass surfaced but did not finish:
  - A relation section's empty copy is generic (`No products yet.` under
    "Kit components"). Declare `empty` copy per relation section in the
    manifest so web and native read the same sentence.
  - The `Actions ▾` menu cannot preview bulk verbs at rest: it needs the
    table's `BulkActionsConfig` threaded from `useListBulkActions` through
    `RTable`; today the bar still replaces the chip run once rows are
    selected, so nothing is unreachable.
  - The timeline list view keeps its own controls inside the body; the
    ListTimeline artboard draws them as a second 40px band (mode seg, From /
    To chips, order seg, cohort line).
  - The phone band still carries the grouped toggle beside the view seg;
    the artboard's band has only seg · search · Filter — fold it into the
    Filter sheet with sort and columns.
  - The canvas's NEXT SESSION note still describes this pass; retire it on
    the next canvas edit.

- **Declare `control.options` on enum fields that lack them.** Product
  `category` and inventory `placement` now declare theirs. Thirteen select
  controls still do not: `location.type`, `meal.mealType`/`mealKind`,
  `ledgerParty.kind`, `project.status`/`kind`/`defaultTrade`,
  `task.status`/`trade`, `purchase.defaultTrade`, and
  `expense.lineKind`/`lineBasis`/`costType`/`trade`. Their labels live only
  in web option modules (`ENTITY_SELECT_OPTIONS` in
  `apps/web/src/entities/editing/select-options.ts`, built from
  `capitalize`, `PROJECT_STATUS_LABELS`, `ledgerPartyLabel`, and similar), so
  the native editor falls back to the list filter's bare enum values
  (`filterValues(for:)` in `EntityOperations.swift`). Move each value→label
  table into `packages/schemas`, declare it on the manifest control, add a
  compiler check that fails an option-less `select` enum, then drop the
  Swift fallback. The web rich options (icons, colors) stay layered on top.

- **Photo-flow leftovers from #1084/#1086.** Small, independent:
  - `PhotoRelatedCreateEditor.renders(_:)` hides `pendingImageIds`,
    `removeImageIds`, `imageOrder` by literal; emit the image-field key set
    from `image-policy.gen.ts` into `PhotoImportCatalog` and read it there.
  - `PhotoImportManifest.startAnalysis` cancels and relaunches, but the
    cancelled task's handler skips the `.idle` reset and the new `analyze()`
    returns early on `isRunning`, so a `.task` re-fire mid-run can leave the
    state stuck at "running". Reset on cancellation, or gate on a generation
    token instead of the flag (plausible, not reproduced).
  - `PhotoImportFullScreenViewer` decodes full resolution per page with an
    un-cancelled `Task.detached`; a fast swipe queues one ~190 MB decode per
    page. Cancel on page change and cap in-flight decodes at one.
  - `EntityDetailView.swift:25` `body` sits at ~207 ms against the 200 ms
    type-check limit and flickers in and out of the warning; split it like
    `PhotoImportHero`/`PhotoLibraryCell`.
  - The classification sweep and the review sheet's `LocalPhotoAnalyzer` share no Vision
    gate (sweep 2 concurrent, analyzer 4); if a review-sheet analysis measurably slows while the
    sweep runs, add a `PhotoVisionGate` actor both acquire, with the sheet yielding the sweep.
  - `PhotoLibraryStore.refresh` reads analysis snapshots for the whole library on every
    PHPhotoLibrary change; scope it to visible months (the `MonthCachingCoordinator` already
    knows them) and load the rest lazily per section.
  - `query(_:preloaded:)` still does one `hash(for:)` actor round trip per never-hashed asset
    on first run; batch the misses once the batch read can say "looked up, absent".
  - The `createSelf` compile check verifies "target is creatable" via
    `contract.create !== null`, not the runtime kernel binding's
    `createInput` (the generator runs before that file exists); if the two
    ever disagree the route fails at commit time with `CONSTRAINT_VIOLATION`
    instead of at generation.

- **Classification list filter has no tree grouping.** The `idMulti`
  `productCategory` column filter renders through `MultiselectEditor`, not
  `FilterableCombobox` — the group-header + depth rendering `tree-items.ts`'s
  `treePickerItems` now feeds `EntityPicker`/`FilterableCombobox` (single-value
  filters) needs a parallel `group`/`depth` on `FilterableComboboxItem` there
  too, plus `useFilterOptions`'s hashing to key on the tree shape, not just
  the flat option list.

- **Location search hits carry no structured ancestor path.** The blank-query
  location picker groups by root and indents by depth now
  (`buildLocationComboboxItem`, `combobox-builders.tsx`), because it carries
  `ancestors: [{id,name}]`. A typed-query search hit only has
  `searchHitSchema`'s flat title/subtitle string — parsing that back into a
  path is out of scope. Add a structured `path` to location search hits so
  the typed-query picker can read as a tree too.

- **`location.tags` has no redundant-token prune target.** `product.tags`
  gets `control.suggest.mode: "prune"` (`redundant-tokens.ts`); the mechanism
  is generic but `location.tags` holds only `collection:*` entries in
  practice today, so its registry entry is deferred until locations actually
  accumulate restating tags worth pruning.

- **Project/Task parent pickers stay flat.** `task.projectId`'s and any
  project-parent picker's rosters are shallow enough that hierarchical
  grouping (`treePickerItems`) is not worth the wiring yet — revisit if
  either roster grows deep nesting.

- **Test the merge dialog's impact preview.** `entity-merge-dialog.tsx`
  renders a `MergeImpactPreview` per loser in both the ranked and fixed
  dialogs, but only the delete dialog's preview has a unit test. Add one for
  a blocking disposition on one loser that leaves confirm enabled.

- **Cover the photo-group review's untested guards.** Add regression tests for
  the photo-groups route's household-member check (404 for a non-member), the
  `state='proposed'` guard on the approval `lastError` write, and the
  frozen-group toast after a save into a just-committed group
  (`apps/web/src/routes/api/import/runs.$publicId.photo-groups.ts`,
  `apps/web/src/app/import-runs/photo-group-review.tsx`).

- **Sweep exact-count test pins.** Assertions that pin a registry total
  (operation counts, method counts, path counts) fail on every legitimate
  addition without guarding behavior; the HTTP contract tests dropped theirs.
  Find the rest and replace each with the invariant it stood in for
  (uniqueness, coverage against the source registry) or delete it. Keep
  one-directional ratchets that caught real regressions (the positional
  OpenAPI component bound).

---

## Ready projects

- **Backfill image descriptions as a paced, visible sweep.** Product
  classification evidence is built from `image-description` analyses, but
  automatic scheduling is off (image-processing settings `enabled: false`) and
  `schedule_image_processing` queues one image at a time, so nearly every
  product photo is undescribed and category suggestions see only text. Add a
  "describe every undescribed image" command that enqueues `describe_image`
  jobs in pages on the existing `ImageProcessingJob` queue, with a cap, the
  existing pause, and a coverage readout (described / eligible). Decide whether
  to turn automatic scheduling on for new uploads. Measured cost is about
  $1.10 per 1,000 images at ~7 s each, so parallelism sets wall time.

- **Batch the image-sighting backfill.** `LibraryMetadataSync` writes one
  `resources.imageSighting.create` per sighting at four concurrent requests, and
  the generated routes expose only create/get/list/update/delete for the entity,
  so a first backfill on a large member library is thousands of round trips. A
  bulk create route would cut that to one request per page; the adapter already
  upserts on the unique key, so batch semantics match the single write. The
  client side is ready — the sync plans a whole pass before sending, so it has
  the full pending list in hand.

- **Native clients follow merge redirects and show connections.** The API now
  returns `redirectedFrom` and `previousShortcodes` on every detail read and
  serves `entityGraph.connections`, but CubbyKit ignores all three: a merged
  code opens the survivor without saying so, and the Relations surface has no
  physical-connections section or delete impact preview. Mirror the web
  behavior (a "was X" banner, the connections list, the advisory preview).

- **Post-import shelf triage.** After a vendor purchase import every new
  product lands in the `unlocated` saved view (`entities/view-manifest.ts`:
  bought, never sold, held nowhere) and the operator decides each one by hand:
  discard, stock it at a location, or park it in the household **Unknown**
  location. The verbs exist — `discard` (ledger-only exit when unstocked),
  `addToInventory`/`receive`, and `location.ensureGlobalUnknown` (the
  recount and sweep flows already call it) — but there is no one-pass flow.
  Build a guided pass over the `unlocated` rows offering exactly those three
  choices per product: a one-click "Park in Unknown" (ensure the global
  Unknown, create the entry there so it surfaces in `unknownParkedItems`) and
  a stock amount defaulted from the quantity ledger (`expectedQuantity −
  onHandUnits`; `product-hero-presence.ts` computes the presentation and is
  currently unused) instead of `QuickInventoryAdd`'s constant `1`. Detail
  pages have no prev/next navigation, so use the guided-flow shape
  (`problem-actions.ts` `start-recount`), optionally scoped to one import run
  (`product-import-runs.tsx` already knows it). Receiving stays explicit
  (purchase-import plan decision 15).

- **Make grouped entity lists correct across pagination and sorting.** Grouping
  already reaches the server, but headers count only loaded rows and omit
  groups not yet loaded. Keep grouping primary before pagination, with
  relevance and user sorts within groups; relevance-only search currently
  bypasses group ordering in `listScaffold.orderBy`, and `buildOrderBy` must
  promote a later group field in a multi-sort. Derive group metadata from the
  filtered set for truthful counts. Cover search, secondary group-field sorts,
  and groups spanning pages. Generic Cards/Compact views omit group
  headings; fix those before extending grouped Flow beyond Tools. Focus on
  `apps/web/src/server/repo/list-scaffold.ts`,
  `apps/web/src/server/repo/database-helpers/query.ts`,
  `apps/web/src/app/_components/data-table/useDesktopGroupedRows.ts`, and
  `apps/web/src/app/_components/entity-list/entity-shelf.tsx`.

- **Native slot list views are hidden from the view picker.** Calendar,
  board, gallery, and analytics `list.views` slot entries exist in the
  manifest, but `EntityListView.swift`'s view picker does not surface `slot`
  kind views yet, so they are unreachable on Apple platforms even where a
  native slot component exists.

- **`resolve_ingredients` suggests product links.** A newly resolved ingredient
  can remain unlinked to an existing matching product. Products with
  `ingredientId: null` do not contribute costing until hand-linked. Return
  `candidateProducts` by name similarity and accept
  `linkProductId` in the same call. Pairs with the coverage-visibility entry
  above.

- **`resolve_products` should share `global_search`'s lexical engine.** Name
  variants such as
  `Organic Example Fruit` and `Example Fruit` should resolve through the same
  lexical matching that powers `global_search`. For grocery the ASIN collision
  check
  misses the Fresh / Whole Foods / in-store ASIN split constantly, so the name
  fallback is load-bearing. Ideal shape: one call taking `{name,
  externalIds[]}` per line and returning exact-id hits, alias hits, and lexical
  candidates together.

- **Actionable meal suggestions.** `/meals/suggestions` is already reachable
  from navigation. Remaining scope: link missing ingredients to their repair
  surface, allow adding shortfalls to the shopping list, and add an entry
  point from inventory.

- **Cookbook browsing.** Add search, sorting, and a browsable/filterable subjects
  facet. Partial-import repair stays on the existing Problems worklist.

- **Cookbook metadata editing.** Allow imported cookbook titles and other source
  metadata to be corrected after import, including malformed OPF titles. Cookbook
  is still write-once in the entity kernel (`bindings.unit.test.ts` asserts
  `updateInput` is null), and a recipe's cookbook link cannot be re-pointed from
  the recipe form even though the generated update field group already permits
  `cookbookId` — wire both in the same slice.

- **Coverage diagnostics on recipe and product writes.** Recipe create returned
  `totals: pending`, so finding the uncosted lines took a separate
  `explain_recipe_costing` per recipe per fix. Return
  the per-line `missing: [price|weight|nutrients]` list inline on recipe
  create/update, and on product updates report which recipe lines the change
  closed: one corrected package-weight mapping can repair many recipes.

- **Duplicate a meal or copy last week.** Add the remaining calendar round-trip
  shortcuts for repeating an individual meal or a prior week without rebuilding
  it by hand.

- **Fix actions for financial duplicate findings.** Give duplicate transaction
  source-ref and account-alias Problems findings a safe targeted action, without
  widening the general entity-merge system to money entities.

- **Guided placement pass for unlocated products.** Walk a value- or
  category-bounded worklist one product at a time with three answers: not tracked,
  place here, or skip. Reuse the existing location picker and immediate-write
  inventory flows.

- **Import extracted cookbook bundles.** Accept ingredient-parser's `.cookbook`
  archives with extracted recipes and images through the existing cookbook
  review/import flow (`recipe/cookbook-import/cookbook-dropzone.tsx`). Read ZIP entries
  incrementally in a Web Worker and upload selected assets with bounded
  concurrency; keep validation and recipe creation on the server. Large bundles
  must not require loading the entire archive into memory. The first version
  requires an open tab; add R2 staging or Workflows only when unattended or
  resumable imports become a demonstrated need.

- **Ingredient coverage visibility.** The ingredient list already shows a USDA
  badge, a recipe-usage-count column, and a binary has/none product-presence
  filter. Remaining scope: a combined, mapping-quality-aware signal/filter
  that surfaces heavily used ingredients lacking a usable Product mapping
  specifically, not just ones with no Product at all.

- **Ingredient detail editing and recipe-usage repair.** The ingredient detail
  page already hosts product/USDA (`IngredientProductShelf`) and unit-mapping
  (`UnitCoveragePanel`) sections. Remaining scope: let `naKinds` be edited
  after creation (currently create-only), and add a reparse action to the
  recipe-usage drift indicator, which is presently read-only. Use this
  representative workflow to deepen the shared editing module only after its
  concrete needs are proven; do not add speculative editor ports first.

- **Itemization and settlement verdict on the transactions list.** The
  linkage exists (`FinancialTransaction ──< Allocation >── Purchase ──<
  Expense`) but the two halves of "is this charge itemized?" sit on different
  lists: `/finance` transactions have only the has/none purchase-presence
  filter, and the reconciliation verdict (`unknown`/`match`/`refund_adjusted`/
  `mismatch`, `financial-reconciliation.ts`) lives on `/purchases`. Add a
  derived transaction column with a filter over: bare (no Purchase), linked to
  a single productless lump line (order booked, not itemized), itemized and
  reconciled, itemized and mismatched. Distinguish sole-charge mismatches from multiple charges
  on a shared purchase (installments or combined charges). Count product-linked lines per
  allocated purchase; do not compare a shared purchase's lines against one
  charge's amount.

- **Identify the specific record a photo belongs to, not just its type.** Photo
  import (app and `cubby photo analyze`) stops at the entity type: for a first
  photo of a plant the per-record ranking has no signal — OCR needs a label in
  frame, the date match needs a same-day `sowedOn`/`transplantedOn`, the Vision
  feature print only matches photos *already attached* to that record, and the
  classifier label (`plant 0.9`) is identical for every candidate — so the
  chooser is in default order and the household picks by hand. The on-device
  Foundation Model is text-only (it sees `classifications: plant, foliage;
  text: none` plus candidate names and passes through as "Deterministic local
  evidence"), and Vision ships no species classifier, so on-device cannot close
  this. Two pieces, both generic over the routing policy's `candidateFields`:
  - **Server vision identification.** A `photo-import.identify` op (native
    flagged) running a `defineFeature` sibling of `product-identification`
    (`server/ai/features.ts`, fast tier, cached, persisted as `aiAnalysis`)
    over the staged R2 bytes plus the loaded candidate rows; returns ranked
    ids with confidence and a one-line rationale. The app feeds it into
    `PhotoEvidenceScorer` as an identity-class score, shows it as a seventh
    section in the Diagnostics tab and the CLI (`--identify` needs auth), and
    calls it only when the deterministic pass found no identity signal. Needs
    an eval set like `inventory-detection-evals.ts` before it ranks anything.
  - **Widen the on-device visual match.** `PhotoVisualEvidenceMatcher` compares
    against each candidate's directly owned gallery attachments one at a time;
    let it use every image reachable through the manifest's `visualEvidence`
    paths (a planting's garden-entry photos, a recipe's meal photos) and take
    the best of several references, so the second photo of a plant matches
    even when the first was filed on an entry rather than the planting.
  Owners: `apps/web/src/server/ai`, `services/photo-import-*`,
  `apps/apple/CubbyKit/Sources/CubbyKit/Photo/PhotoEvidenceScorer.swift`,
  `App/Shared/Photo/Library/PhotoVisualEvidenceMatcher.swift`.

- **Label photo → `labelNutrition`.** The Brami panel was transcribed by hand
  from a photo pasted into chat. Accept an attached image on the product and
  extract the Nutrition Facts panel into `labelNutrition` with the image as
  provenance.

- **USDA search ranking and product-driven suggestion.** `search_usda_foods`
  is phrase/AND matching: `"chicken breast ground raw"` (sr_legacy) → 0,
  `"chicken, ground"` → 344. Tokenize and rank, and add
  `suggest_usda_for_product(productId)` that searches on name + brand + GTIN
  (Mary's chicken resolved to Pitman Farms only by knowing the parent brand).

- **Variance-targeted recount pass.** Seed a recount session from the
  shelf-versus-ledger disagreement worklist so the pass visits the products that
  actually disagree wherever they live.

- **Local passwordless dev sign-in.** Agents cannot type credentials, so
  browser-pane verification against the seeded local dev database
  (`pnpm dev:local`) needs a human to sign in. Add a route that mints the
  synthetic dev user's better-auth session, registered only under `vite dev`
  with a `DATABASE_URL` that passes `tooling/dev-db-guard.ts`, excluded from
  the Workers build, same-origin redirects only, and documented next to
  `pnpm dev:local`.

- **Flue `photo_inventory` coordinator.** A hosted coordinator that works a
  photo run through `propose_photo_groups` and `propose_product_match` from
  on-device analysis text (never raw bytes): a coordinator prompt,
  `claim_next_import_work` support for image targets, and the Flue SSE channel
  on the run page in place of 3s polling. Photo runs are excluded from dispatch
  today (`run-service.ts` throws "Photo inventory runs have no dispatchable
  work").

- **Lift photo-run image bytes straight from the device.** The Apple uploader
  round-trips every photo through R2 before on-device analysis; hand the
  analysis the local bytes and upload once
  (`apps/apple/CubbyKit/Sources/CubbyKit/Photo/PhotoImportRunUploader.swift`).

- **Move the purchase run detail onto generic entity-detail slots.**
  `ImportRunContent` in `apps/web/src/app/purchases/purchase-import-run-detail.tsx`
  is hand-written even though `importRun` is a manifest entity.

---

## Requires database changes

- **Carry the member through queued AI work.** Search-query embeddings,
  image-processing dispatch, location AI refresh and inbound purchase-mail
  classification run under `systemActor()` because no actor reaches them
  (`server/semantic/embeddings.ts`, `image-processing/dispatch.ts`,
  `background-tasks/handle.ts`, `agents/purchase-import/extract.ts`). The
  system actor is meant only for work with no member present: thread the
  request actor (or its `runId`) into the queue messages and the search read
  path so these runs name the member who caused them. The Flue provider
  (`apps/purchase-agent/src/cubby-ai-provider.ts`) still tags gateway metadata
  with `jobKind: "purchase_import_run"`; send the run id once Flue exposes the
  current run to module-scope providers.

- **Finish the `ImportRun` → `Run` rename.** Runs now group all AI work
  (`ai_suggest`, `ai_action`, `background`, `file_import`, `legacy` purposes),
  but only the UI label and `/runs` route were renamed. Still named
  `ImportRun*`: the parent table, entity key, `ImportRunId` type, the child
  tables (`ImportRunTarget`, `…OrderCandidate`, `…Evidence`, `…Mutation`,
  `…Operation`, `…Progress`, `…ControlEvent`), `ImportSourceClaim.firstRunId`/
  `lastRunId`, `Purchase.importRunId`, `ImportFinding.importRunId`, raw-SQL
  name strings (`repo/activity.ts`, `problems/detectors-integrity.ts`,
  edge-policy keys), and the generated Apple types. Leave Flue runtime
  identifiers (Durable Object `purchase-import-run`, `finish_import_run` /
  `stop_import_run_for_review` tools) unchanged, because a separately deployed
  worker and in-flight runs depend on them. Ship it as a
  `scripts/cutovers/*.sql` cutover, not `db:push`.

- **Schema-bearing PRs must not auto-merge ahead of their runbook.**
  `deploy.yaml` deploys every `main` push and never applies schema; the
  image-provenance PRs (#1193, #1198, #1201) auto-merged green and deployed
  against a database that lacked `Device`, `ImageSighting` and the new
  `Image` columns until `docs/runbooks/image-provenance-schema.md` was run by
  hand. Rule: a PR whose runbook adds a table/column is opened as a draft or
  without auto-merge until the expansion is applied and read back; consider
  a CI job that diffs `application-schema.json` against the live schema and
  blocks merge on a missing column.

- **Anchor the remaining polymorphic references on `Entity`.** ADR 0006 gave
  `AuditLog`, `SearchDocument`, `EntityEmbedding`, and `DataException` a
  composite `Entity(id, kind)` FK. `AiAnalysis`, `AiUsage`, `ImportRunMutation`,
  and `ImportFinding` still carry unenforced `(entityType|targetType, id)`
  pairs with bespoke merge and removal cleanup. Classify each one (history that
  keeps its original identity vs a live pointer that follows a merge), then
  convert one table per cutover; a pair whose target can be a non-entity row
  (`import_run`, `expense` without a shortcode) stays as it is.

- **Finish the meal amount migration.** `MealFoodEntry` and
  `MealRecipePortion` still retain legacy `grams` columns and read/input
  compatibility paths. Verify legacy rows and writers have drained, remove
  those paths, deploy and drain the previous build, then drop the columns and
  tighten constraints. Follow the [meal amount cleanup runbook](runbooks/meal-food-entry-schema.md#3-later-cleanup)
  and verify the resulting schema; do not infer production readiness from code.

- **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
  by giving cookbooks durable identity plus a merge/repoint path.

- **Count units resolve on the ingredient, never via product `each`.** `1 whole
  example vegetable` must not resolve to the weight of an entire linked bag
  because its `each` satisfies `whole`. Product `each` means *package*; recipe
  `whole/bunch/crown/clove` means *piece*. A USDA portion can supply the
  ingredient-specific piece-to-gram mapping. Rule: piece units come from USDA
  `portionInfo` or an ingredient-level mapping, and product `each` prices the
  package only — it must never satisfy a piece unit.

- **Line-level discounts with a Product link.** Whole Foods promos and Amazon
  Buy-Again are per line, but a `discount` row cannot carry `productId`, so
  they are booked order-level and every promoted grocery's cost basis is list
  price (synthetic example: a $10 item discounted to $8). Allow `productId` (no quantity) on
  `discount` rows and fold linked discounts into derived cost basis without
  changing `SUM(Expense.cost)`.

- **Manual shopping items with durable checks.** Give the shopping list
  server-backed item identity so ad-hoc entries such as milk or paper towels and
  checked state persist across date ranges and devices. Keep the list independent
  of inventory writes.

- **Measured quantity on Expense lines.** A receipt can state `0.5 lb @ $4/lb`
  (synthetic example); the current legal booking is `productQuantity: null`,
  which discards the measured quantity. Booking variable-weight purchases as
  individual "units" instead produces a meaningless derived unit price. Let
  `productQuantity` carry `{value, unit}` (lb, oz, each) and normalize through
  the Product's `unitMappings`, so derived pricing becomes price-per-measure
  for weight lines and stays per-unit for packaged ones.

- **Portion shares alongside grams.** Once a household stops weighing and
  serves by eye ("one diner ~40% of the pot"), grams are a proxy that goes stale
  when `estimatedYieldGrams` changes. Accept `{share}` per portion in
  `save_meal_recipe_preparation` and derive grams at read time from the
  current yield.

- **Project materials and shortfalls.** Add a project-material edge with quantity,
  free-text unit, optional Product resolution, and durable/consumable semantics;
  derive have/need/buy through the availability engine without reservations or
  automatic inventory decrement.

- **Recurring maintenance tasks.** Add simple every-N-weeks/months recurrence;
  completing an instance creates the next one, which naturally enters Needs
  Attention. Cover every completion path with one idempotent transactional rule,
  not a scheduler or RRULE system.

- **Saved user-created views.** Persist named filter and sort sets using the
  versioned external-state pattern, and render them alongside the
  manifest-defined `presentation.list.views` without creating a second query
  language.

- **Structured location segments for photo runs.** `ImportRun.notes` carries
  location-by-time-window prose that the agent parses; give photo runs
  structured time-window → Location segments so proposals default their
  inventory location without interpretation.

---

## Requires thought or evidence

- **Bulk product re-categorization sweep.** Re-running the `product.categoryId`
  suggestion over the catalog has no run record, progress, pause, or review
  surface; past sweeps were ad-hoc agent batches. Build a sweep that records
  each product's suggestion (target, branch-rolled confidence, runner-up), applies only
  high-confidence changes, and queues the rest for review. Decide where the
  run lives: an `ImportRun` purpose, the activity `runProjection`, or a
  shared sweep primitive also used by the image-description backfill. Run it
  after that backfill, since the basis is mostly text until then. Measured:
  about $0.10 per 1,000 Jev calls at a 2.3k-token roster; bursts near
  600/min see ~6% throttling, so pace at a few hundred per minute. The
  response cache keys on the taxonomy revision, so any category edit
  invalidates a completed sweep.

- **Image embeddings stopped being written.** On 2026-09-23 only 20 of about
  6,300 live Images had an `EntityEmbedding` row, and none was newer than
  2026-09-21, while every other embeddable kind was fully covered. The loader
  exists (`getImageEmbeddingTexts` in `repo/entity-embedding-refresh.ts`), so
  find out whether image refreshes are never enqueued, filtered out before
  embedding, or were simply never backfilled, then backfill and add a guard
  (a detector threshold or a test) that catches a kind going silent.

- **Measure the delegate-less routing change.** Around 2026-10-06, re-measure
  30 days of Claude session transcripts against the baseline in
  [model routing](agents/model-routing.md#delegate-or-not): share of sessions
  that spawn subagents (about half), subagent share of context tokens (47%),
  and subagent output on Opus/Fable. Keep the rule if the shares fell without
  slower or lower-quality sessions; otherwise revise it.
- **Jev suggestion for `product.ingredientId`.** The manifest and registry
  already support it (`readKey: null` reference targets work in
  `scripts/generator/entities/compile.ts` and `readReferenceField` in
  `entities/entity-references.ts`); the open question is the roster.
  `findLexicalSearchCandidates` ANDs every prefix term (`buildPrefixTsQuery` in
  `repo/search-lexical.ts`), so a full product name never matches a short
  ingredient, and per-word fan-out still misses abbreviations and synonyms.
  Decide between semantic candidates (`services/semantic-search.service.ts`),
  the whole ingredient list if it stays small, or lexical fan-out plus aliases.
  Basis `name, manufacturer, categoryId, notes` — the category lets Jev return
  none for non-food. Pairs with the `resolve_ingredients` product-link entry.
  Other fields without `suggest` (`location.parentId`,
  `productCategory.parentId`, `recipe.cookbookId`, `ledgerParty.kind`,
  `product.growsIngredientId`) stay manual: rare, deliberate edits.

- **Completeness scores for every entity — exceptions still to come.** Every
  scored household entity now declares `capabilities.dataQuality` in its
  manifest (see `docs/entities.md` → "Data quality") and gets a computed
  0–100 score, `dataStatus`/`dataGap` list filters, and a `sort=dataQuality`
  worklist ordering (ascending = weakest first), fulfilling most of the
  [universal scoring commitment](plans/purchase-import-redesign.md#10-pre-implementation-improvements).
  What remains: durable "not available" exceptions still only exist for
  Product and Purchase (the `dataExceptions` jsonb column and
  `set_data_exception`/`clear_data_exception` are hardcoded to those two —
  see "Generic durable data exceptions" below); the per-check weights shipped
  are a first cut and may need tuning once worklists are used in anger;
  `projectsMissingBudget` remains a Problems tracker rule, not a `dataQuality`
  check, because its subtree spend rollup is not a per-row predicate.

- **Incremental import cursors and paced backfill.** The account cursor declares
  newest-date/order-ID and backfill bounds, but imports do not advance them;
  only the oldest available history boundary is recorded. Restore the
  [incremental sync and backfill flows](plans/purchase-import-redesign.md#5-flows):
  advance cursors after successful processing and resume newest-first backfill
  with the planned 20–30 orders/hour pacing. This is durable progress and pacing,
  separate from the conditional vendor-pagination evidence item below.

- **Vendor evidence classification.** `orderEvidence` has a manual editor and
  drives checks, but the [decision 14 classification pass](plans/purchase-import-redesign.md#2-decision-log)
  and batch review are absent. Use vendor identity, website, charge descriptors,
  and order-mail evidence to suggest classifications; decide confidence
  thresholds and fit accepted writes into the current approval model.

- **Complete charge-to-order discovery.** Gmail discovery handles unique exact
  amounts and order subsets, but lacks the [planned matching sequence](plans/purchase-import-redesign.md#47-server-gmail-discovery):
  consult retained shipment-payment evidence before mailbox matching, then use
  a bounded Jev tie-break for ambiguous mail candidates. Preserve member/vendor
  scoping and unresolved outcomes when evidence cannot support a match.

- **Import decision evaluation.** The [planned offline evaluation](plans/purchase-import-redesign.md#6-cost-and-evaluation)
  needs representative, sanitized identity, line-role, and reversal cases with
  known outcomes and measured provider decisions. The current static Product
  reuse fixture checks a result shape; it does not establish decision accuracy
  or calibrate confidence thresholds. Evaluate the current shared-agent path
  and its bounded decisions without committing private source material.

- **CalDAV event deletion.** The HTTP adapter returns 405 for DELETE and directs
  users to Cubby. Resolve the [deferred client-precondition policy](caldav.md#storage-and-writes)
  for clients that omit `If-Match`, then implement canonical conditional deletion
  through the adapter and Durable Object. Keep deletion in Cubby until then.

- **Review suggestions across a full filtered list.** The inline suggestion
  pass checks opened pages only. Design an explicit interactive scan with
  progress and individual acceptance before expanding beyond loaded records.

- **Apply a reviewed purchase-validation diff.** Targeted validation now
  records a read-only semantic diff and stops for review. Design the explicit
  human confirmation, stale-target revalidation, and transactional application
  path before allowing any proposed validation change to touch Purchases,
  Expenses, Product assignments, settlement, or shared evidence.

- **Generalize evidence-backed Product enrichment beyond Amazon.** Add fixed
  source adapters for retailer SKU, catalog/item number, and GTIN evidence;
  each batch declares each field's expected current and replacement values, and
  applies only those proven corrections. Preserve current values unless an
  explicit correction is evidenced.
  Readable page text and free-text source hints are not write authority.

- **Dependent batch program.** Define a bounded program of named operations
  whose results feed later inputs. Specify input/result limits, dependency
  failure propagation, ordered partial outcomes, and retries that preserve
  completed writes. Carry an explicit continuation for unfinished work.

- **Manual purchase lifecycle.** Define one compact run that expands selected
  candidates into evidence, automatic receipt outcomes with attachment ids and
  classifications, replay-safe writes, and multi-order handling. Keep a
  multi-order export as run evidence. Record the run evidence and terminal
  outcomes so interruption resumes rather than duplicating work. Close the
  [grouped-settlement commitment](plans/purchase-import-redesign.md#47-server-gmail-discovery):
  Gmail can identify several orders for one charge, but the writer matches
  separate exact-amount transactions per Purchase. Turn a confirmed group into
  the corresponding allocations atomically and without duplication; leave
  ambiguous or incomplete groups for review.

- **Conditional purchase-import browser extension.** Promote only if the
  Apple-event browser bridge repeatedly fails to background its owned window,
  cannot avoid Chrome's JavaScript-from-Apple-Events setting, or otherwise
  cannot provide reliable capture plumbing. Tab grouping alone does not justify
  the extension. Keep it thin: window ownership and capture plumbing only; it
  must not gain Cubby credentials or business-write access.

- **True full-page image-rich browser evidence.** The shipped rendered PDF is
  an honest snapshot of Cubby's dedicated browser viewport, paired with the
  searchable normalized PDF. Promote a stitched/print-quality full-page capture
  only when the viewport misses evidence needed for a real import; do not label
  viewport capture as full-page in the meantime.

- **Gmail discovery re-authentication.** Promote when a production Gmail
  request returns 401/403 after a refresh-token expiry or consent revocation.
  Show an actionable reconnect path, preserve the resumable Problem, and avoid
  silently treating authorization failure as an empty mailbox.

- **Finish terminal browser cleanup.** Promote when production logs show
  browser commands surviving a completed, failed, or needs-review run, or an
  owned browser window remaining visible after failure/review. Terminalize or
  reject queued commands by run generation, send one terminal client signal,
  minimize only Cubby's window, and surface discarded work in the run log
  without touching a successor run.

- **Typed pagination and final grocery evidence.** Promote when a real vendor
  exposes pagination or grocery pages whose last page is not represented by
  the current hints. Add typed pagination state and an explicit exhausted
  result, then capture final item/settlement evidence rather than relying on
  an intermediate list response.

### Needs a decision or investigation

- **Detail ledger dates.** Task Overview shows `Due` and `Due end` as two
  identical ISO rows (`2026-09-22` twice) for a single-day task, while the
  header reads `Added Sep 18, 2026`. Decide whether a same-day range
  collapses to one `Due` row (keeping `Due end` editable from the edit
  sheet) and whether detail facts use the human date format; both are
  manifest `display.format`/field decisions, not ledger CSS.

- **Phone hit areas as pseudo-elements, app-wide.** Button's default
  `mobileSize: "touch"` grows icon controls to 44px *layout* boxes, which
  wraps dense rows on phones. The detail ledger now keeps the 44px target as
  an `::after` (suggestion glyph, cohort filter link, field-explanation
  trigger; the `checkbox.tsx` pattern). Decide whether `touch` itself should
  become a pseudo-element target so other dense surfaces (phone cards,
  relation section headers) get the same density without per-call-site
  classes.

- **Fixture-backed web preview route.** Web has no `#Preview` equivalent:
  seeing a component's empty, loading, error, or edge state means driving the
  full app against the dev server's `DATABASE_URL`, which is the shared prod
  database (real records in screenshots, writes land in prod). A dev-only
  route rendering components from `mock()` fixtures
  (`apps/web/src/lib/test/mock-schema.ts`) in named states, read through the
  browser pane with HMR, would mirror the Apple loop in
  [docs/agents/xcode-mcp.md](agents/xcode-mcp.md) without Storybook's weight.
  Promote when agents keep reproducing edge states against real data; decide
  how it stays out of the production bundle (`mock-schema.ts` imports faker).
  The data half is now covered: `pnpm db:dev:up/push/seed` plus `pnpm
  dev:local` (`apps/web/tooling/scenarios/corpus.ts`) gives a persistent
  local database with named, non-empty entities in every state the corpus
  covers, so `dev:local` no longer needs the shared prod `DATABASE_URL` for
  this. What remains is the route/component-preview half — driving one
  component into an arbitrary state (loading/error/edge) without navigating
  the full app to reach it.

- **E2E against the dev server.** `pnpm --filter @cubby/web test:e2e:watch`
  runs Playwright against a `vite build --watch` Worker bundle plus warm
  PostgreSQL/IntegreSQL containers, not the Node `vite dev` server — Node
  `vite dev` is not workerd, so tests that depend on Worker-only behavior
  (bindings, Durable Objects, the entity-kernel routes as actually deployed)
  would not exercise the real runtime there. Investigate whether a
  `dev:local`-backed lane is worth adding as a faster iteration path for
  UI-only specs; it could never become the CI merge gate (`docs/ci.md`
  requires the workerd-backed harness), only an optional local shortcut.

- **Declarative "many, clamped to one" cardinality.** The image-provenance
  work chose a many-row `ImageSighting` entity plus derived declared-`one`
  Image fields over turning scalar relations into arrays with a runtime
  clamp. Cardinality is a compile-time `one|many` literal
  (`packages/schemas/src/entity-definitions/definition.ts`, relation
  metadata) consumed by the editor branches, `image-policy.gen.ts`'s
  `source-id` vs `source-id-list` bindings, Swift `FieldReference.multiple`,
  every scalar FK column, and ADR 0001's no-generic-edge rule. Revisit only
  when a second entity needs multi-evidence provenance; the existing
  relation `provenance.sources[]` is the declarative construct to extend
  first.

- **Generic HTTP `resources.<entity>.batch` route.** MCP `entity_batch` runs
  up to 50 create/update commands per call, but the HTTP surface is one row
  per request, so a native bulk write (library sighting backfill, PR 5 of
  the provenance plan) issues one generated `create` per row. Promote if a
  5k-asset library makes that measurably slow; the route should mirror
  `entity_batch`'s independent-item semantics and benefit every entity.

- **One FROM context per entity list.** Every list repo pairs a Drizzle
  relational `findMany` rows query (root table aliased to its lowercase name;
  Column objects rewritten, `sql.raw` strings and nested `PgSelect` builders
  not) with an unaliased `$count` on the same where clause, so any predicate
  that references the outer row by raw table name or through a correlated
  sub-select compiles on one leg and throws `invalid reference to FROM-clause
  entry` on the other — six shipped occurrences so far (#456, #462, #481,
  #762, #785, CUBBY-11R). The sanctioned workarounds (uncorrelated `IN`
  sub-selects, dual-alias where builders, string alias parameters on
  `effective*Sql` fragments) are guarded by
  `server/entity-kernel/list-smoke.integration.test.ts`, which exercises every
  declared filter and sort per entity. Decide the durable shape: plain-select
  rows with explicit relation joins, one `alias(table, name)` shared by every
  leg, or Drizzle relations v2 — each removes the string alias contract from
  `expense-inheritance.ts`, `task/lookup.ts`, and `image.ts`.

- **Evaluate Cloudflare Workflows across durable background work.** Compare
  image description/eligibility/companion processing, purchase import and
  targeted validation/enrichment, and bounded backfills/maintenance against
  their existing queue, lease, and Flue orchestration; use search-index repair's
  existing Workflow as a concrete reference. Include cookbook imports only if
  unattended/resumable execution becomes necessary. Reverse-connected clients
  can complete external-event waits through the authenticated server; retain
  the device bridge, authorization, idempotency, and output validation. For each
  candidate identify orchestration code replaced, retry/state ownership,
  recovery behavior, operational cost, and test/deployment impact before
  adopting it. Keep shared run history independent of the execution engine.
  See the [purchase-import plan](plans/purchase-import-redesign.md) for the
  existing runtime boundaries. Include device-local work (library scan,
  classification sweep, sighting backfill): the native
  `BackgroundActivity` shape mirrors `ActivityRun` so posting those runs into
  the `runProjection` union (`apps/web/src/server/repo/activity.ts`) is a
  transport addition, giving cross-device history without a remodel.

- **Live Activities for server runs started on this device.** Record the initiating
  install separately from `ActivityRun.executors` (which identifies where work
  ran), then send per-activity ActivityKit push updates for state changes so
  the originating phone can show progress after Cubby is suspended. Keep the
  native Live Activity's local-work feed separate from server run history.

- **MCP staged-file storage.** Before sharing a local upload beyond its signed
  grant, define no-copy activation, replay behavior for a signed grant,
  activation fencing, delete-before-grant-expiry handling for a recreated
  orphan, and ownership of workflow evidence. Build on the `EntityAttachment`
  and file-liveness model from the
  [durable identity plan](plans/entity-identity-and-files.md) once it ships.

- **Host-provided MCP file references.** Adapt client-owned file handles and
  download URLs through capability-specific input metadata and the existing
  validated URL-fetch path. Downloadable URLs remain the fallback; no upload UI.

- **Durable MCP transfer telemetry.** Persist call duration, serialized response
  bytes, and per-item outcomes when repeated measurements justify it. Expand
  telemetry storage and queue consumers compatibly before new producers; the
  current lightweight tracing does not require this migration.

- **Cluster and reproduce the native app-hang corpus before changing code.**
  Collect sanitized release, duration, foreground state, and the top symbolicated
  main-thread frames for each Sentry family; group by shared app frames rather
  than issue id. Reproduce each surviving family in a Release build without
  LLDB and use Time Profiler for busy-main-thread work or System Trace for
  waits/locks. Keep hang tracking enabled and make one repair per demonstrated
  root cause rather than treating repeated samples as independent bugs.

- **Make generated native response decoding forward-compatible.** The current
  image-detail failure may be either a missing required `useOriginal` field or
  an older strict client rejecting additive representation fields. Capture the
  sanitized decoding path first, then fix the generator so output projections
  tolerate additive server fields while request/input schemas remain strict;
  keep this lane exclusive over OpenAPI and generated Swift, and deploy the
  backward-compatible server behavior before distributing the client.

- **Reproduce macOS photo-match export inside the sandbox.** Capture the
  underlying error chain and sandbox denial for Downloads, Desktop, and an
  iCloud Drive/file-provider destination before choosing between exact-file
  authorization, coordinated writes, or per-file copying. Keep the existing
  user-selected entitlement; do not add broad access or persistent bookmarks
  for an immediate export.

- **Validate image bytes before AI description.** The image-description path
  hands a Cloudflare rendition URL to the provider without proving that the
  response is decodable image content. First confirm the gateway adapter's
  supported binary input shape, then validate MIME, magic bytes, and bounded
  size at the outbound boundary so transformation error bodies never reach the
  model and the durable image job records a truthful failure.

- **Capture exact runtime error shapes before broadening suppression.** The
  remaining client-disconnected cancellation, missing update-result, opaque
  database failure, and pathological LIKE/GLOB reports need sanitized
  name/message/stack/route evidence and an event-shaped regression test before
  changing global filters or contracts. Archive expected noise only after the
  narrow classifier is proved; do not hide unrelated transport or query errors.

- **Generate a `/new` contract for every creatable entity.** Keep rich Product
  and Recipe creation pages; generate redirects from dialog-created entities'
  `/new` URLs into their list `?create=true` deep links. Validate recipe
  share-target and direct-link behavior before changing routes.

- **Trial `@cf/baai/bge-base-en-v1.5` via AI Gateway alongside OpenAI.**
  Vectorize's per-vector cost is model-agnostic, so a cheaper/faster
  Workers AI embedding model is worth comparing against the OpenAI adapter
  for recall quality before committing to it as the default. Use these
  query/expected-top-result pairs as the eval set (moved here from the
  deleted `server/semantic/search-evals.ts`):
  `"plastic tarp"` → `blue plastic tarp` (product); `"drop cloth"` →
  `plastic drop cloth` (product); `"where are tarps"` →
  `tarps cloths blankets` (location); `"packout"` → `packout organizer`
  (product); `"parchment"` → `parchment paper` (product); `"tarpaulin"` →
  `blue plastic tarp` (product); `"cling film"` → `plastic wrap` (product);
  `"adjustable spanner"` → `adjustable wrench` (product); `"wet dry vac"` →
  `shop vacuum` (product); `"painters cover"` → `painters drop cloth`
  (product). Trap: `bge-base-en-v1.5` embeds at a different dimension than
  OpenAI's model, and `EntityEmbedding`/Vectorize rows are keyed on
  `(provider, model, dimensions)` — `findRelatedSearchCandidates`
  (`server/services/search.service.ts`) must resolve the active
  `SemanticEmbeddingConfig` before embedding the query text, not embed with
  a stale/hardcoded dimension and silently miss every stored vector.
  `refreshEntityEmbeddings` (`server/background-tasks/embedding.ts`) now
  embeds a whole queue batch in one call, so this eval set can be run
  against production-shaped 10-text batches instead of one query at a time.

- **Dev Vectorize REST client, if semantic search in plain-Node dev is ever
  wanted.** The vite Node dev server has no `VECTORIZE` binding, so
  `semanticEmbeddingsConfigured()` (`server/semantic/embeddings.ts`)
  degrades to unavailable there today — that's a deliberate simplification,
  not a bug. If local semantic search becomes worth the cost, add a
  `VectorStorePort` implementation over Cloudflare's Vectorize REST API
  (account id + API token) instead of loosening the gate.

- **`AiUsage` rows for `entityEmbeddingRefresh` are now per batch, not per
  entity.** Since `refreshEntityEmbeddings` embeds a whole queue batch in one
  provider call, the recorded row carries `inputCount` for the batch but no
  `entityId` — attributing gateway spend back to a single entity needs a
  different aggregation if that's ever wanted.

- **Cloudflare AI Search (managed RAG over R2 files) for a future
  document-Q&A feature.** Evaluated and rejected for entity similarity
  search (this pass's problem): it ingests files from R2 rather than rows,
  re-indexes on a schedule rather than per-write, and returns chunk results
  rather than entity refs — none of which fit "find the Product/Location/…
  this query means." Worth a second look only if Cubby ever wants
  free-text Q&A over uploaded documents (receipts, manuals) as its own
  feature, which is a different problem than entity search.

- **List-route SSR payloads are large.** Unauthenticated probes measured
  `/projects` at 826 KB, `/locations` 655 KB, `/recipes` 579 KB of HTML.
  Find what the generic list loader and the slot views dehydrate (a full
  first page plus the calendar/dashboard data is the likely answer) before
  deciding whether to trim the loader, defer slot data, or leave it.

- **Eyeball `/graph` after the canonical-owner change.** #1067 made the
  foreign-key side own a physical path shared by two declared relations
  (`entity-graph.ts` `canonicalPaths`), so arrows that used to read
  `product → inventory` now read `inventory → product`; the tests were
  updated but the Relationships tab and `/graph` were not inspected for
  relations declared on both sides.

- **Narrow the `e2e` Nx target's inputs, then cache it.** `nx affected`
  treats all of `apps/web/src/**` as an e2e input. The target is uncached
  (container side effects), so explicit `verify:local` runs always pay for
  Playwright; pushes run no validation. `apps/web/tests/e2e/spec-areas.ts` now
  maps every spec to the routes/feature dirs/contracts it exercises for local
  selection (`pnpm --dir apps/web test:e2e:affected`), but that's a
  developer-loop narrowing, not an Nx input — deciding whether a cache hit on
  an unchanged tree is acceptable evidence for the Nx target, and whether to
  reuse this same manifest for it, is still open.

- **Consumable vs durable as a Product attribute.** The distinction is
  currently encoded by convention as "expense on `PRJ-HSHD` vs no project",
  living only in the purchase-import skill notes; `stockTracked` half-encodes
  it. A first-class `Product.kind` (or consumable flag) would let the import
  default the project, the shelf worklists filter, and the convention stop
  needing rediscovery per importer.

- **Inferred-zero nutrients for label data.** USDA `branded_food` records and
  household `labelNutrition` carry only what the label prints (11 nutrients
  for chicken, panko, parm, chilies), so macro coverage read 11/12 with the
  only "missing" line being salt's protein. FDA labels must declare calories,
  total/saturated/trans fat, cholesterol, sodium, carbs, fiber, sugars, added
  sugars, protein, vitamin D, calcium, iron, potassium; a manufacturer may omit
  one only as "not a significant source" (below rounding). So for label-sourced
  records a missing *mandatory* nutrient is an inferred zero and a missing
  micronutrient (zinc, B12, magnesium, folate…) stays unknown. Model nutrient
  values as `measured | inferred-zero | unknown`; count inferred zeros as
  covered but flag them. Manual override: extend ingredient `naKinds` with
  nutrient keys for true edge cases — but not salt, which is the largest sodium
  source, and whose unmeasured "to taste" line is currently planned at 1% of
  pot weight (13.6 g salt ≈ 5 g sodium in a 1.3 kg pot), worth a sanity check.

- **Ingredient as the grocery dedupe hub.** Product is SKU-grade and
  Ingredient is the commodity layer, but imports never fill `ingredientId`,
  so the catalog now holds `Cauliflower` / `Organic Cauliflower, 1 Each`,
  `Organic Kiwi` / `Organic Green Kiwi, 16 oz`, `Broccoli Crowns` /
  `Broccoli Crowns (Conventional)`, and three ground-beef 80/20s with nothing
  tying them together — each a defensible SKU, none reachable from the
  others. Suggest or require an Ingredient on grocery Product creation and
  make `resolve_products` search ingredient aliases, so "banana" resolves
  regardless of which storefront's ASIN the receipt carries.

- **Meal nutrition goals.** Let meal planning compare planned nutrition with
  explicit household goals using the existing recipe nutrition totals.

- **Meal templates.** Save reusable meal compositions without coupling them to
  recurrence.

- (lead) **React #418 hydration error on `/garden-entries`.**
  Logged in production on both route loads; reproduce in dev before deciding
  on a fix. Two related, reproducible-in-dev leads seen 2026-09-16 on `main`:
  every sortable list header hydrates with a different dnd-kit
  `aria-describedby="DndDescribedBy-N"` than the server rendered (dnd-kit's
  id counter advances per SSR request in the long-lived worker), and
  `@tanstack/react-router-ssr-query` 1.167 calls `hydrate(client, undefined)`
  on the query stream's final `done` read, which query-core 5.102 logs as
  "Error reading query stream … reading 'mutations'". Both are console noise
  today; fix by seeding dnd-kit's `id` per request and upgrading the router
  ssr-query package once it guards `done`.

- **Reconsider the remaining USDA MCP App.** The Shopping List App is gone;
  `get_shopping_list` is a plain structured/text tool. The remaining USDA
  Picker template is 352,004 bytes raw / 83,655 gzip and builds in 132 ms on
  the local M3 development machine. Keep it only while refinement and explicit
  selection materially outperform a plain `search_usda_foods` result.

- **Recurring meals.** Add a focused recurrence model for meals as its own slice,
  separate from templates and nutrition goals.

- **Server-backed table intelligence.** Extend exact facet counts and honest
  aggregate summaries from Expenses to one justified server-paginated surface at
  a time; never analyze a partially loaded client page as the full population.

- **Swift 6.4 / OS 27 readiness pass on the Apple app.** Before a toolchain or
  deployment-floor change, audit state initialization, concurrency boundaries,
  availability, and resizing against the actual SDK. Verify custom initializers and
  Sendable assumptions with focused behavior tests.
  Preserve the supported OS 26 path until a floor bump is explicitly chosen. Owners:
  `apps/apple/project.yml`, `apps/apple/App`, and `CubbyKit`.

- **Product match queue recall and cost.** A full queue read makes up to 60
  vector lookups (top 20 neighbours each), and a photo↔purchase pair is missed
  when the purchase Product is outside that neighbourhood and shares no name
  token. Measure misses on real wardrobe imports before widening, caching, or
  moving detection to write time
  (`apps/web/src/server/services/product-match.service.ts`).

- **Cross-vendor style-number matching.** Purchase prep reports an exact match
  for a vendor-sourced `retailer_sku`/`asin` or a GTIN, so a brand style number
  recorded from a tag matches only the brand's own shop, not a department
  store selling the same item. Decide whether a manufacturer part-number kind
  is worth adding or whether barcodes plus the match queue suffice.

- **Receiving an already-photographed purchase.** Purchase import raises a
  receive finding for every order; receiving an item already stocked from
  photos double-counts it, and the match card only warns that merge sums both
  sides. Decide whether the receive finding should check for a pending match
  pair first.

- **Photo-group approval racing a concurrent save.** A stale approval can
  commit a photo that a concurrent save moved to another group, which then
  fails with "inconsistent target state" until removed. The failed-operation
  retry's compare-and-set takeover also lacks a regression test (it did not
  interleave reliably on one test connection). Decide whether either needs
  more than the current recovery path.

### Waiting for a trigger

- **Follow-ups gated on image provenance landing** (see the
  [plan](plans/image-provenance-and-devices.md)); each promotes on its own
  trigger:
  - *Geolocated photo → nearest Location suggestion* in import review, once
    Locations carry coordinates (the coordinate field renderer from PR 3b is
    reusable).
  - *Capture date as inventory evidence*: a sighting's `capturedAt` says a
    product existed / was at a Location on that day; emit it as a timeline
    event when the inventory timeline next needs external evidence.
  - *Cross-member duplicate review*: the same pixels in two members'
    libraries already produce two sightings; a review queue reusing
    `PhotoMatchStore` candidates is worth it once ambiguous attributions
    accumulate.
  - *Per-feature participation sub-switches* (companion jobs vs library
    processing) if the single master switch proves too coarse.
  - *`MenuBarExtra` companion status on macOS*: the app works in the
    background unconditionally today; an always-visible indicator is honest
    once the sidebar rows from PR 4 exist.
  - *Hash-repair egress budget*: repair downloads full originals
    (`PhotoMatchStore.repair`); cap per session and prefer Wi-Fi when cellular
    use is observed.
  - *Shortcuts App Intent "Log this photo to Cubby"*: on-device, keeps
    location; depends on the import path carrying the `library` block.
  - *Map / per-place / per-trip photo filters* once GPS is stored.

- **Trace the web Worker's AI calls into Sentry's Agents view.** The purchase
  agent reports `gen_ai` spans through Flue's Sentry blueprint, but the web
  Worker's structured AI features (`server/ai/run-feature.ts`, embeddings) do
  not: Sentry's Workers AI integration only wraps `env.AI.run()`, never the
  `env.AI.gateway("cubby").run()` transport Cubby uses, and the TanStack AI
  adapters bypass Sentry's provider integrations. Adding it means a
  `@tanstack/ai` `ChatMiddleware` (next to `ai-gateway-usage.ts`) that opens a
  `gen_ai.chat` span with the request model and token usage. Do it when a
  web-side AI feature needs per-call latency or cost debugging that the AI
  Gateway dashboard cannot answer.

- **`get_vendor_coverage` per account** — Promote when two members hold
  accounts at the same vendor. Coverage and `needs_data` are per Vendor
  today, which would conflate their histories.

- **`PurchaseLine` SKU annotation** — Promote when store SKU, quantity, or unit-price
  detail is genuinely wanted. It is annotation only; `Expense` remains financial
  truth.

- **Aggregate range materiality** — Promote if always-on cost/calorie/weight ranges
  create visible noise; keep authored line ranges and collapse only immaterial
  aggregate spreads.

- **Before-drywall spatial capture** — Promote immediately when construction is
  scheduled; define the smallest room/wall-indexed photo packet before walls close.

- **Budget-aware MCP pagination** — Promote when a real tool result hits an output
  limit or is measurably too large. Define stable keyset cursors, explicit compact
  JSON byte and aggregate-result limits, and a continuation that preserves the
  chosen filters, sort, and budget. Mixed entity/action read batches need
  explicit per-family bounds and result attribution.

- **Core native inventory experience.** Promote when everyday use of the native
  redesign exposes a specific inventory bottleneck. Deepen location-first browsing,
  stock comparison, capture/recount, and photo completion; introduce bulk actions
  or drag/drop only for a demonstrated workflow. Owners:
  `apps/apple/App/Shared/Browse`, `Capture`, and `Audit`; see [native design](../apps/apple/DESIGN.md).

- **Decode bytes in image verification** — Promote when a corrupt or fully transparent
  cover is next found by eye. `inspectImageFile`
  (`apps/web/src/server/services/image-integrity.ts`) checks magic bytes, header
  dimensions, byte length and sha256 but never rasterizes, so `verify_product_images`
  reports `verified` for files that will not render. A subagent citing the verify tool
  is therefore not proof of a good image.

- **Entity relation runtime dispatch** — Promote when attach/detach genericization
  resumes. Generate dispatch only for declared runtime ports and make unsupported
  semantic edges fail explicitly; catalog relationships must not imply executable
  mutation behavior.

- **Estimated-allocation analytics caveat** — Promote when materials-versus-labor
  analytics inform a real decision; disclose the allocation-basis portion without
  excluding it from total spend.

- **Exact entity attribution for `attach_files`** — Promote if mixed-entity batches
  distort the MCP usage dashboard. The batch attributes telemetry to its first item's
  entity because one row has nowhere to put a set; a batch spanning entities
  under-reports the rest.

- **Evaluate trade affinity in expense project suggestions** — Check once the
  `expense.projectId` roster's per-project trade tallies (`renderLine` in
  `server/ai/field-suggest/registry.ts`) have served real suggestions in
  production: compare accept/override rates on `/ai-usage` against the
  date-window-only roster, and drop the tallies if they add tokens without
  better picks.

- **Exact nutrition source tracing** — Resume when upstream conversion work is in
  scope. Extend `ingredient-parser` reports to retain actual mapping identities,
  directions, and competing mappings from the selected calculation path. Then
  update Cubby and expose Product/USDA/manual-mapping provenance through nutrient
  cells and nested recipes, including consumption and yield adjustments. Show
  selected results with conflicting alternatives and repair links, preserving
  existing resolution rules. Return inspected values and traces from the same
  computation; never infer selected sources from matching values or linked-product
  lists. The Cubby-only nutrition overhaul does not depend on this work.

- **Explicit idempotency key for `add_recipe_to_meal`** — Promote if a re-sent agent
  call actually duplicates a meal line in practice. A natural-key unique index is NOT
  the answer: a meal repeating a recipe at different scales is intended behavior, and
  each occurrence must stay a distinguishable shopping-list contribution. Retry-safety
  needs a caller-supplied key. The guard test that named this as intentional was
  deleted with the tRPC-era `meal.integration.test.ts` (#914) and never replaced, so
  the first slice of this — or of any meal-line work — is a `workflows/meal.server.ts`
  integration test asserting one meal holds one recipe twice at different scales with
  two independent shopping-list contributions.

- **`stored` descriptor sweep per repository** — Promote when a hand-built
  list drifts from its declared columns. Every list repository now composes
  through `listScaffold`; what remains hand-written are predicates over
  subqueries, OR-groups, array columns and shortcode resolution, plus single
  stored-column `eq`/`ilike`/`inArray`/`gte`/`lte` calls that could be `stored`
  descriptors (`product/crud.ts` and `purchase.ts` carry most). Convert per
  repository and verify with the real-query matrix; leave joins alone.

- **Harden `createDeleteProcedure`'s id contract** — Promote if a second hand-rolled
  delete procedure appears. It infers its id type from the callback and then casts
  (`id as TId`), so a branded parameter alone does not catch a caller passing the
  wrong id form — that is how shortcode-vs-uuid image deletion shipped to review.
  Every entity going through `createEntityCrudRouter` is safe today because that
  config requires an `idSchema`; a hand-rolled call site can still omit one.

- **Let the negative-expected-quantity worklist converge** — Promote when the
  `negativeExpectedQuantity` view is next worked. It reads the kit-projected quantity
  (`kit-projection.ts`), and after triage most survivors are settled decisions —
  big-ticket items whose acquisition predates ledger coverage — with nowhere to be
  recorded: `dataException` has no such check, yet `view-manifest.ts` asserts the view
  converges. Two designs were costed and the operator chose to leave the detector alone
  (2026-08-18): book the missing unit as an Expense with `cost: null,
  productQuantity: 1` (no code change; the ledger already reads a NULL cost by the
  quantity's sign, but zero such rows exist today), or add a product data check with a
  **ledger-derived** fingerprint — the obvious `updatedAt`-keyed version is unsafe,
  because adding a real acquisition would not re-open the row.

- **Location subtree filters** — Promote when direct-child filtering demonstrably
  blocks a location or inventory workflow; use a scoped descendant-id helper rather
  than the relation-heavy whole-tree CTE.

- **Driven simulator smoke for the photo flow** — Promote when the next
  SwiftUI identity/state bug ships (the stale second `.sheet(item:)` in
  #1084 was the first). `apple-check.sh` now gates the known pattern
  (`State(initialValue:)` from init); the only thing that catches *unknown*
  ones is a scripted run: `simctl addmedia` two fixture photos, then drive
  select A → Add to… → Cancel → Clear → select B → Add to… via Axiom `xcui`
  and assert the hero's identifier names B. Keep it out of the pre-push gate;
  run it from `apple-check.sh` behind a flag.

- **Match book scans against ledger-imported books** — Promote when the next ISBN scan
  mints a twin. `findOrCreateByISBN` (`product-orchestration.service.ts`) matches on GTIN
  only, and Products created by the eBay/Amazon ledger imports carry no ISBN, so a scan
  duplicates a book that already has purchase history; the merge that follows is lossy.
  Either backfill ISBNs onto import-created book Products from their external ids, or
  fall back to a title/author match before creating.

- **Measured table-virtualizer investigation** — Revisit direct-DOM-write
  virtualizer options only during a measured desktop table-virtualizer
  investigation (re-check `@tanstack/react-virtual`'s current API for a
  low-render-overhead update mode; the option this line previously named,
  `directDomUpdates`, no longer exists in the installed version).

- **Move the UPC-batch detector out of the problem-count badge** — Promote if
  the badge's refresh-behind-read ever shows up in request timings: one detector
  (`productsWithBetterUpcData`) calls the external UPC lookup, so the badge
  refresh is not pure SQL. Moving it to the coverage page (computed on that
  page's load) keeps the badge cheap without losing the detector.

- **Timeline notes carry links and product `usedOnProjects`** — Promote when
  the "N products omitted" sentences in the product timeline need to be
  clickable again or a project link is wanted on a lifecycle row:
  `EntityTimelineOut.notes[]` are plain strings and `rows[]` has no project
  slot, both dropped when `product-movement-views.tsx` became the generic
  `EntityTimeline` in #1067.

- **Multi-product Expense links** — Promote when one Expense genuinely needs several
  Products and `splitExpense` cannot truthfully split the money.

- **Named web fidelity losses from the manifest-rendering pass** — Promote a
  follow-up if a household workflow misses one: the task subtask checklist is
  now a relation table, not an interactive checklist; project's in-detail
  tasks list/board toggle is gone; purchase lost its per-line
  quantity/unit-cost columns; location's merged sub-locations+items surface
  split into two sections; product's hero lost its stock-stats row.

- **Native specialized-renderer editors** — Promote per field as a native
  workflow needs to write it. The native generic editor has no control for
  product `unitMappings`/`labelNutrition`, financialAccount `sourceAliases`,
  financialTransaction `sourceRefs`, or any `structured-field` (recipe
  `sections`/`yield`/`meta`, meal `recipes`, expense and ledgerTransfer
  `sourceClaims`, financialAccount `identity`/`cardNumbers`).
  `NativePresentationCoverage` classifies them as unsupported and
  `EntityEditorSheet` shows "Additional fields are available on web", so they
  are not dropped silently. Expense `beneficiaries`/`funders` are done
  (`LedgerAttributionsControl`). On web, `cardNumbers` has no editor at all —
  only the create form's "Last four" seeds a primary entry; the dated history
  is MCP-only.

- **Receipt-minted provisional accounts** — Promote when the next one appears.
  A provisional `FinancialAccount` with no source aliases whose every live
  transaction has `sourceRefs = []` was minted from receipt digits (FAC-J7CE,
  2026-09-19, was the Apple Pay device number of FAC-E67H). Now that
  `cardNumbers` gives those digits a home, a Problems finding should flag the
  shape so it gets folded into the funding account instead of lingering.

- **Native workflow parity with web.** Promote when a recurring household task
  still requires switching to the web. Native already renders every manifest
  create/update through the generic editor: add generated editor focus order with
  Next/Done only when keyboard entry demonstrates a repeated friction, and make
  sheet state/lifecycle comprehensive only when a concrete re-presentation,
  cancellation, or saving handoff fails. Port one complete detail/list slot or
  action loop at a time, preserving existing contracts and specialized behavior.
  Owners: `apps/apple/App/Shared` and the generated `EntityCatalog`; build/capability
  context lives in [the native README](../apps/apple/README.md).

- **Generated native list/detail parity.** Keep Swift on the existing generated
  `EntityCatalog` and OpenAPI contracts. Revisit shared Rust only when a
  concrete cross-client rule cannot be expressed by those surfaces; do not
  create a second entity catalog pre-emptively. Add collapsed-section parity
  only after a manifest-supported consumer needs it, with the same declared
  section state and accessibility behavior on both clients.

- **Native numeric entry and units.** Net-new work: promote fractional/numeric
  text entry and unit steppers only after a concrete native amount workflow
  shows that the existing decimal fields are insufficient. Define locale-aware
  parsing, validation, display, and the unit contract before extending generic
  number or amount controls; do not fold it into inventory work by default.

- **Native system-surface expansion.** Promote one surface only after a recurring
  household workflow names it: Quick Look for typed attachments, typed drag/drop,
  additional App Intents, widgets, extensions, voice entry, timers, or Live
  Activities. Each slice must retain explicit user-confirmed writes and use the
  existing entity/link contracts rather than creating a parallel state model.

- **Offline native writes and multiwindow.** Promote only when disconnected use
  or concurrent native windows blocks a demonstrated household workflow. This
  needs an explicit write/retry/conflict model and window ownership rules; it is
  larger work than the current session-only navigation and immediate-write flows.

- **Natural CI evidence** — Revisit sharding only when ordinary exact-head runs
  show a repeatable tail imbalance or regression. Use native reporter output;
  do not add duration databases, custom sequencers, or manufactured timing runs.

- **On-device Apple Intelligence.** Promote when supported household devices and a
  measured capture friction justify one concrete draft-assistance workflow. Evaluate
  against representative fixtures, preserve manual entry and existing services, and
  require confirmation before writes. Owners: `apps/apple/App/Shared/Identify`,
  `Photo`, and `Intents`. Confirm actual SDK/device support before selecting APIs.

- **Per-edge breakdown for purchase merges** — Promote if `merge_entity`'s empty
  `moved` array on purchase is noticed in use. `foldChargeInto` moves expenses and
  documents without counting them, so purchase reports a measured `merged` count but
  no per-edge detail, unlike the other three merge entities.

- **Persisted Collections and operational dashboard** — Temporary smart starters
  now evaluate manufacturer, exact tags, Location/ancestor name substrings, and
  historical actual Expense Trades, with editable OR rules and source evidence.
  Promote when Collection tags need metadata, rename-safe empty identity,
  durable rule editing, richer rules (for example, minimum effective price), or combined
  Project/Task/Expense views; migrate `collection:*` tags into durable records
  rather than layering on a parallel mapping. Smart membership should evaluate
  a saved Product filter at read time rather than auto-tagging matching records.
  Extend the existing historical Trade predicate with deterministic “primary
  inferred Trade matches” by reusing Product-to-Trade inference. Trade remains
  on the Product's linked Expense lines, not its parent Purchase. Dashboard
  expansion still includes combined Project/Task/Expense views.

- **Portion solver** — Promote if agent-side amount iteration remains painful after
  the recipe nutrition MCP projection ships; solve component weights against macro
  constraints in one call.

- **Product external-ID collision worklist** — Promote a broader Problems surface if
  auto-minting imports create a persistent operator queue beyond the existing
  `product.externalIdCollisions` query.

- **Production query-cost repair** — Promote the specific offender confirmed by a
  fresh production trace, including a Problems count-only path or whole-catalog
  purchase aggregates; remeasure before restructuring counters.

- **Promote harvested equivalences into the unit graph** — Promote when the
  ingredient equivalences report's suggestions are repeatedly re-applied by hand. The
  report (`lib/harvest-equivalences.ts`, `ingredients/equivalences-report.tsx`)
  harvests ingredient-scoped unit equivalences from recipe parentheticals on demand;
  writing an accepted one into a durable ingredient-level unit mapping is the deferred
  next step, and there is no such store yet.

- **Purchase evidence references** — Promote when Gmail, Drive, or portal evidence
  must be queried repeatedly beyond Purchase notes and attached documents.

- **Purchase replacement/exchange relations** — Promote when those relationships
  need navigation or querying rather than truthful Purchase notes.

- **Push change feed for post-mutation refresh** — Promote only when a derived
  value users actually wait on (an AI location description, a recipe total
  cascade) reliably lands after the client's fixed +5 s / +30 s deferred
  refetch (`lib/deferred-invalidation.ts`). The design is a Durable Object
  change feed over the WebSocket Hibernation API: the queue consumer pings it
  after each task, the browser subscribes once per session and invalidates the
  task's cache tags on each event. Rejected for now because it is ~300–400
  lines of new infrastructure (DO, binding, auth on the socket, reconnect, a
  workerd test) in a repo whose direction is removing execution infrastructure,
  and the fixed refetch covers the observed latencies for a single-user tool.

- **Repeat-purchase ranking** — Promote when enough Products have genuine repeated
  acquisitions to make a cross-product ranking useful.

- **Residual N+1 repair** — Promote only when a fresh network trace finds a concrete
  products, recipes, or inventory-detail query fan-out.

- **Returned-unit price advisory** — Promote when another stocked Product has a
  materially inflated derived price or a structural signal can distinguish returns
  from sales. Keep the response advisory until that distinction is reliable; an
  ambiguous heuristic must not silently rewrite valuation.

- **Selection-control consolidation** — Promote a specific selector family when
  visual or keyboard inconsistency becomes painful; preserve specialized interaction
  contracts rather than forcing one universal control.

- **Selective SSR expansion** — Promote another route family only if the
  product-detail pilot wins a cold-cache browser comparison without an INP, CLS, or
  Worker-error regression.

- **Sentry lazy initialization** — Promote if a fresh bundle treemap shows Sentry is
  still a material critical-path dependency.

- **Services-with-product advisory** — Promote when the first live row appears or an
  import repeatedly creates one; keep it advisory rather than a database constraint.

- **Shopping pack rounding** — Promote when a real shopping workflow needs it and a
  representative purchasable Product/pack mapping has an explicit selection rule.

- **Split compound ingredient lines** — Promote when `ingredient-parser` can emit
  two ingredients from one line. Blocked upstream, not locally: `parse_ingredient`
  is singular and upstream deliberately keeps "Salt and pepper" whole (`usage.rs`
  pins it as one `Seasoning` ingredient). Splitting stored rows first does not
  hold — every affected row carries a `rawLine`, so the split reads as parse
  drift and "Re-parse all" reverts it, and `ReparsedStaleLineWrite` is
  one-row-in-one-row-out by contract. Scope when unblocked: 14 ingredients over
  212 rows in 204 recipes, all with empty `amounts` — that emptiness is the
  discriminator against single ingredients whose name merely contains "and"
  (`cilantro leaves and stems`), which all carry amounts. Choose each split
  target from the row's `rawLine`, not the ingredient name: the largest compound
  absorbed several raw variants as aliases and they do not all name the same
  salt. Route writes through `handleSectionUpdates` via the entity adapter so
  `sortOrder` renumbering, totals staleness and embedding refresh come free, and
  send each touched section's complete ingredient array — omitted lines are
  hard-deleted. Repoint the existing row to the first child and insert only the
  second, to limit `lineId` churn. MCP cannot drive it: the read projection
  strips section and line ids, so an update omitting section `id` replaces every
  section.

- **Shared-expense export re-import dedupe** — Promote if a shared-expense
  group export (such as a Splitwise CSV) is imported and later re-exported and
  imported again. That export carries no row id, so source-claim provider ids
  are derived from date + description + amount; a later export with an edited
  description will not dedupe against the first import.

- **Person-to-person repayment discovery** — Promote when entering Ledger
  Transfers by hand becomes a chore. Two sources: already-imported aggregator
  statement rows whose person-to-person payments (payment apps such as Venmo
  or Zelle) were never promoted to Financial Transactions, and Gmail "paid you"
  emails. Review-only: propose a transfer, a person confirms, and confirmation
  creates the `LedgerTransfer` and its source claim. Never resolve a
  counterparty automatically (`CONTEXT.md` avoids automatic matches). Context:
  `docs/plans/household-ledger-attribution-followups.md`.

- **Project default beneficiaries** — Promote if shared-cost projects become
  frequent. A fallback tier between an expense's explicit beneficiaries and the
  assumed Household party (explicit, then project default, then household),
  following the live-inheritance pattern in `expense-inheritance.ts`. Needs a
  schema change and an allocation-SQL change.

- **Attribution prefill** — Promote with the same evidence as project default
  beneficiaries: default the expense editor's beneficiaries/funders to the last
  set used with the same vendor.

- **ImportFinding as a manifest entity** — Promote once a second parent needs
  its list: today findings render as a slot on the run page and through the
  Problems `importFindings` key. `ImportRun` itself became `importRun`
  (`RUN-`, read-only) in 2026-09; its other children (targets, evidence,
  operations, approvals, progress) stay internal rows with no life outside a
  run. A finding is the one child with its own lifecycle (open → applied /
  dismissed) and a Purchase relation, so it is the natural next promotion —
  it costs a prefix, a backfill, an `AuditEntityType`, and the delete/resolve
  disposition decision the StatementRow item below also waits on.

- **StatementRow and StatementImport as manifest entities** — Promote once the
  `supersededByRowId` disposition is decided (block, detach, or cascade for a live
  predecessor pointing at a deleted row); "add an edge policy" is not the decision.
  Unblocks the audit gap `deleteStatementRows` currently only documents: StatementRow
  has no `AuditEntityType`, so no truthful `logAuditEntry` call exists and all three
  statement-row mutation paths write no audit trail. Also routes that delete through
  `removeEntity` for cascade and locking. Costs shortcode prefixes, a batched backfill
  of the whole `StatementRow` table, a detail route, and entries in roughly ten
  exhaustive `Record<Entity, …>` tables. Backfill in batches with an in-memory
  set of existing codes; `generateUniqueShortcode` does a SELECT per candidate
  and is wrong for bulk.

- **TanStack Start observability** — Remove Cubby's observability wrapper when
  TanStack Start supplies equivalent named request/result/error events and trace
  hooks: <https://tanstack.com/start/latest/docs/framework/react/guide/observability>.
  Checked 2026-09-16: the guide still says OpenTelemetry support is coming, and
  Sentry's global function middleware cannot name spans per operation because
  every operation multiplexes through one Start function
  (`start-operation-dispatch.server.ts`); `observed-request.ts` also carries
  DB metrics and expected-error filtering. Revisit when Start exposes the
  dispatched operation id to a request hook.

- **USDA duplicate collapsing** — Promote if repeated UPC versions return to useful
  search pages; reuse `dedupeUsdaFoodsByUpc` in the MCP handler rather than changing
  usda-api pagination semantics.

- **Apparel photo routing and size/color fields.** Photo-import routing
  categories are plants, food, documents, and home; clothing is grouped by the
  agent. Size and color live in the Product name and notes, one Product per
  variant. Revisit an apparel photo category once the hosted coordinator
  routes photos, and structured size/color once wardrobe filtering by size is
  actually wanted.

### Long-term visions

- **Ambient capture.** Accept voice memos, forwarded email, shared photos, and NFC
  entry points so reality reaches Cubby with minimal ceremony.

- **Cubby to Home Assistant.** Expose computed shopping shortfalls, maintenance due,
  actionable weekend work, and tonight's meal for household display and voice.

- **Digital twin and spatial memory.** Attach shutoffs, breaker maps, paint, hidden
  utilities, and other building knowledge to the location tree.

- **Grow-to-table loop.** Model beds and plantings, receive harvests into pantry
  inventory, and ask what the yard can supply this week.

- **Heirloom outputs.** Produce a future-owner house manual, project yearbooks, and a
  durable archive/export format.

- **Home Assistant to Cubby.** Turn runtime, energy, fault, weather, and area/device
  signals into maintenance, project evidence, and correctly scoped tasks.

- **Household balance sheet.** Generalize location valuation into replacement
  forecasts, cost-per-project analysis, and insurance or cost-basis exports.

- **Household cash-flow projection.** Planned in
  [household finance synthesis](plans/household-finance-synthesis.md) Phase 2,
  alongside category analytics, a funder-to-category Sankey, and transfer-pair
  acceptance in Phase 1. Net worth and retirement stay out until the
  trusted-household tenet is amended for a time-series table as an explicit
  decision.

- **House timeline.** A chronological house journal with project milestones,
  before/after photos, and an annual wrapped-style view over existing records.
  Build on the generic `resources.<entity>.timeline` capability rather than a
  bespoke aggregation.

- **Recipe scaling extensions.** Explore pan-size targets, interactive parse
  clarification, and baker's-percentage comparison without replacing Product-owned
  density mappings with a global reference table.

- **Seasonal garden planning and photo comparison.** The `garden-plan-import`
  skill already turns a written seasonal plan into Locations/Project/Tasks/
  planned Plantings; build past one-time ingest toward *revising* a standing
  plan season over season, comparing dated bed/tree photos with AI, and
  explaining forecast changes and keep-versus-replace recommendations. Keep
  the workflow occasional and lightweight; planting windows alone do not
  establish maturity or harvest forecasts.

- **Standing household agents.** A registrar for records, quartermaster for
  consumable shortfalls, and foreman for stale or blocked projects, with approval
  before durable writes.

---

## Next pass

Deferred from the 2026-09 manifest-rendering PRs; unordered.

- **Expose recipebridge conversion, needs, costing and nutrition via cubby-ffi**
  only alongside the first native screen that scales a recipe or prices a meal.
  Until then the FFI surface stays `parse_ingredient`, `size_unit_aliases`,
  `normalize_isbn`, `scan_code_gtin14`. Owners: `cubby-ffi/src/lib.rs`,
  `apps/apple/CubbyKit/Sources/CubbyKit/FFI`.

## Deferred: deploy surface

- **Fold `apps/upc-lookup` and `apps/usda-api` into the main worker.** Two
  separate Workers with three contract packages (`packages/upc-contract`,
  `packages/usda-contract`, `packages/usda-schemas`) exist for what are two
  route groups; folding them removes two deploys and the cross-worker contract
  layer. Touches `wrangler` config and the USDA data source binding.

## Operational passes

- **Fill ingredient density gaps.** Use the existing missing-weight list to add
  Product `UnitMapping` data organically as ingredients need it.

- **Fill missing acquisition quantities.** Work through Expenses → Missing quantities
  and record known counts on existing Product-linked acquisition rows; do not freeze
  a changing row count into this file.

- **Register missing payment instruments.** Every card or bank
  account used to pay vendors belongs in Cubby as a
  `FinancialAccount`, or its statement rows can never settle anything. Add the
  missing ones with aliases before the next statement import.

- **Settle bare card charges.** Work from `/finance` with the purchase-presence
  filter set to none, matching existing Purchases before booking new ones
  (`match_expenses`, `suggest_financial_transfer_pairs`). Itemize lump-line
  orders only where a receipt is on hand.

- **Ingest a seasonal garden plan with `garden-plan-import`.** Turn a
  written seasonal plan into Locations, one season Project,
  due-dated Tasks, and planned Plantings by following the skill's playbook.

- **Import the household wardrobe.** One member's clothes per capture session,
  uploaded from the Apple app into a `photo_inventory` run with that member as
  owner; an agent proposes groups with `propose_photo_groups` and a human
  approves them on the run page. Then import the matching vendor orders and
  work the product match queue (`/recommendations/workbench?kind=product-match`)
  so photo- and purchase-created Products converge. Playbook:
  [photo-inventory pilot](runbooks/photo-inventory-pilot.md).
