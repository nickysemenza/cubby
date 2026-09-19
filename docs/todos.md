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

- **`empty_expenses` cannot be excepted.** It is missing from
  `EXCEPTION_REASONS` in `server/repo/data-quality.ts`, so a Purchase whose
  lines will never exist (an in-store receipt that is gone, an online order
  older than the vendor's history) sits in `needs_data` forever. Add
  `unavailable` and `history_expired`, the same class of fix the product
  identity checks got.

- **Expose Jev's raw probability.** `server/ai/jev.ts` buckets the winning
  choice into `high | medium | low` and carries a TODO; threshold tuning and
  any "why did it pick this" surface need the number. Nullable
  `probability` on `JevChoiceResult` and the suggestion schemas.

- **Generate the MCP instructions' prefix list.** `MCP_SERVER_INSTRUCTIONS`
  in `server/mcp/server.ts` hand-lists every shortcode prefix while
  `packages/shared/src/generated/shortcode-registry.gen.ts` already holds
  them. Render the list from the registry plus entity descriptions so a new
  entity cannot drift out of the instructions.

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
    To chips, order seg, cohort line); the product read's own cap is the
    next entry.
  - The phone band still carries the grouped toggle beside the view seg;
    the artboard's band has only seg · search · Filter — fold it into the
    Filter sheet with sort and columns.
  - The canvas's NEXT SESSION note still describes this pass; retire it on
    the next canvas edit.

- **Cap the product timeline like the default one.** `productTimeline`
  (`server/repo/product/movement-timeline.ts`) returns one lifecycle row per
  product in the cohort; an unfiltered `/products?view=timeline` ran 19.6 s
  and rendered ~7 MB of DOM for 6,085 rows. Apply the default
  implementation's 500-row cap with the truncation stated in `notes`/`stats`,
  or page `rows`, and have the list mount refuse to run the read until a
  filter narrows the cohort.

- **Scope the generic dialog's `useWatch`.** `useEntityEditSession` calls
  `useWatch({ control })` at the session level, so every keystroke re-renders
  the whole form (all sections and the image block). The remount bug fixed in
  #1067 was the acute symptom; watch only the fields a presentation depends
  on (`kind`-driven layouts) and let `Controller`s re-render themselves.

- **Give the browser test harness a rejecting default transport.** UI tests
  that mount slots (relatedness rail, product image summaries) reach the real
  Start transport with no server, so `generic-entity-detail.unit.test.tsx`
  needs a console spy and a 1.5 s settle to keep failures from landing after
  teardown. `createBrowserTestHarness` should install a transport that
  rejects synchronously (or the slot registry should take an operations
  seam) so a UI test can never leak a network call.

- **`SelectField` names its picker with the lowercased label.** The generic
  editor's selects read `aria-label="kind"` with placeholder "Select kind"
  while the visible label is "Kind" (`form-utils.tsx` `SelectField` →
  `StaticPicker label={label.toLowerCase()}`). Pass the label as written.

- **Reserve the date field's clear-button width.** `DatePickerInput` mounts
  "Clear date" only once a value exists, so committing a typed date shifts
  everything below it by the button's width; clicks aimed at the next field
  land on whatever moved under them.

- **Require a `label` on reference fields.** A reference field without one
  renders its key humanised ("Location Id") in the editor and facts grid
  (gardenEntry's two were fixed by hand in #1067). Add the compiler check in
  `scripts/generator/entities/compile.ts` beside `validateTitleField`.

- **Declare `control.options` on enum fields that lack them.** Product
  `category`, inventory `placement` and the other option-less enum controls
  make the native editor fall back to the same-named list filter's enum
  values (`filterValues(for:)` in `EntityOperations.swift`); declaring the
  options on the control removes the heuristic on both platforms.

- **`pnpm deploy` is shadowed by pnpm's built-in.** `pnpm --filter
  @cubby/web deploy` errors with `ERR_PNPM_INVALID_DEPLOY_TARGET`; only
  `pnpm run deploy` reaches the script. Rename it `deploy:web` (and update
  `README.md`'s deployment section).

- **Link the generic-page design canvas from `apps/web/DESIGN.md`.**
  <https://claude.ai/artifact/A45j5qz24RjRK6KzKmKLWL> is the spec the
  generic detail/list pages were built against (hero plate, section kinds,
  workbench band, journal variant) and is referenced only from #1067.

---

## Ready projects

- **Product edit still opens `ProductForm` in a dialog** instead of the
  generic editor's `structured-field` renderers, because `unitMappings` and
  `labelNutrition` have no generic port yet. Port them (see
  `product-form-fields.tsx`) and delete the dedicated dialog.

- **Native slot list views are hidden from the view picker.** Calendar,
  board, gallery, and analytics `list.views` slot entries exist in the
  manifest, but `EntityListView.swift`'s view picker does not surface `slot`
  kind views yet, so they are unreachable on Apple platforms even where a
  native slot component exists.

- **`resolve_ingredients` suggests product links.** It created `ground chicken`
  (ING-ZEU3) while PRD-FGC5 "Ground Chicken Breast" sat unlinked; four of the
  five products in that meal had `ingredientId: null`, so nothing costed until
  hand-linked. Return `candidateProducts` by name similarity and accept
  `linkProductId` in the same call. Pairs with the coverage-visibility entry
  above.

- **`resolve_products` should share `global_search`'s lexical engine.** It
  returned no candidates for `Organic Banana`, `Organic Cauliflower`, `Organic
  Green Kiwi` while `global_search` found `Organic Whole Trade Banana`,
  `Cauliflower`, `Organic Kiwi` at once. For grocery the ASIN collision check
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
  `explain_recipe_costing` per recipe per fix (five calls that evening). Return
  the per-line `missing: [price|weight|nutrients]` list inline on recipe
  create/update, and on product updates report which recipe lines the change
  closed (the jar-weight mapping on PRD-Q7KK fixed 14 recipes silently).

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
  reconciled, itemized and mismatched. Measured 2026-09-14 over 3,337 non-void
  rows: 657 bare, 147 lump-line, 1,567 reconciled, 944 one-of-several charges
  on a shared purchase (installments, combined Amazon charges — not
  mismatches), 22 true sole-charge mismatches. Count product-linked lines per
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

- **Line-level recipe patch over MCP.** Three one-field edits (onion `1 whole`
  → `150 g`, basil `1 handful` → `15 g`, pasta 175 → 150 g) each resent all 12
  lines and 6 instructions because the read projection strips section/line ids
  and an update without section `id` replaces every section (see the compound
  ingredient split note). Add `{action: "patchLine", recipeId, lineId, …}`;
  `explain_recipe_costing` already exposes line ids.

- **USDA search ranking and product-driven suggestion.** `search_usda_foods`
  is phrase/AND matching: `"chicken breast ground raw"` (sr_legacy) → 0,
  `"chicken, ground"` → 344. Tokenize and rank, and add
  `suggest_usda_for_product(productId)` that searches on name + brand + GTIN
  (Mary's chicken resolved to Pitman Farms only by knowing the parent brand).

- **Variance-targeted recount pass.** Seed a recount session from the
  shelf-versus-ledger disagreement worklist so the pass visits the products that
  actually disagree wherever they live.

---

## Requires database changes

- **better-auth 1.7 upgrade.** The family is pinned to 1.6.25 in
  `apps/web/package.json` (plus the `@better-auth/core` override in
  `pnpm-workspace.yaml`) and grouped alone in Renovate. 1.7 rewrites
  `@better-auth/oauth-provider`, which the MCP sign-in runs on: `validAudiences`
  and `silenceWarnings` in `apps/web/src/lib/auth.ts` are removed (tsc does not
  flag them), the resource model moves to `resources` +
  `oauth_client_resource`, and the schema gains `oauth_client_assertion`,
  `applicationType`/`clientDiscoveryId`, drops `type`/`public`, and needs a
  `(clientId, resourceId)` dedupe backfill. Regenerate `auth.schema.ts`, write
  the migration, port `withDefaultResource` (`server/oauth/default-resource.ts`)
  to the new resource contract, and verify the claude.ai connector flow by hand
  — no E2E covers it. Also lifts the nested `better-call` peer rule.

- **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
  by giving cookbooks durable identity plus a merge/repoint path.

- **Count units resolve on the ingredient, never via product `each`.** `1 whole
  yellow onion` costed as 1,360 g because the linked product is a 48 oz bag and
  its `each` satisfied `whole`. Product `each` means *package*; recipe
  `whole/bunch/crown/clove` means *piece*. Garlic resolved correctly only
  because a USDA portion supplied clove → 3 g. Rule: piece units come from USDA
  `portionInfo` or an ingredient-level mapping, and product `each` prices the
  package only — it must never satisfy a piece unit.

- **Line-level discounts with a Product link.** Whole Foods promos and Amazon
  Buy-Again are per line, but a `discount` row cannot carry `productId`, so
  they are booked order-level and every promoted grocery's cost basis is list
  price (Applegate patties $14.79, paid $11.10; 8× Ellenos at $3.49 list
  inside a $15.86 order savings). Allow `productId` (no quantity) on
  `discount` rows and fold linked discounts into derived cost basis without
  changing `SUM(Expense.cost)`.

- **Manual shopping items with durable checks.** Give the shopping list
  server-backed item identity so ad-hoc entries such as milk or paper towels and
  checked state persist across date ranges and devices. Keep the list independent
  of inventory writes.

- **Measured quantity on Expense lines.** Amazon states `0.99 lb @ $8.99/lb`
  and `0.77 lb @ $3.49/lb`; the only legal booking is `productQuantity: null`,
  which discards the fact a pantry cares about most and leaves weight-priced
  Products (Mary's chicken breast: $11.89 / $14.98 / $15.58 / $34.52 booked
  as four "units") with a meaningless derived unit price. Let
  `productQuantity` carry `{value, unit}` (lb, oz, each) and normalize through
  the Product's `unitMappings`, so derived pricing becomes price-per-measure
  for weight lines and stays per-unit for packaged ones.

- **Portion shares alongside grams.** Once the household stops weighing and
  serves by eye ("Nicky ~36% of the pot"), grams are a proxy that goes stale
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

---

## Requires thought or evidence

### Needs a decision or investigation

- **`Entity` supertable for polymorphic references.** Three patterns
  coexist for a row that points at any of several entity types: untyped
  `entityType + entityId` with no FK (search index, embeddings, AI analysis,
  `AiUsage`, audit log); `Image.targetType/targetId` plus eight per-entity
  join tables; and an exclusive-arc CHECK (`LedgerSourceClaim_owner_check`).
  Decided (2026-09-19): one `Entity(id, kind, body, deletedAt,
  mergedIntoId)` table populated by `insertWithShortcode`, composite FKs
  `(id, kind)` from every polymorphic table, global shortcode allocation,
  and merge redirects via `mergedIntoId` — which also fixes the link a merge
  loses today. Design and migration in
  [the purchase import redesign](plans/purchase-import-redesign.md) §10
  item 7; it is that plan's first pre-work PR and becomes ADR-0004.

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
  treats all of `apps/web/src/**` as an e2e input, so every web push pays ~2
  minutes of Playwright in `verify:push` where the old path classifier ran it
  only for routing paths; and the target is uncached (container side effects),
  so `verify:local` always pays it too. Decide which paths genuinely change
  browser behavior (routes, app shells, the worker entry, `tests/e2e/**`) and
  whether a cache hit on an unchanged tree is acceptable evidence.

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

- **Marketplace seller on Amazon purchases.** `Sold by:` (YANTURION, MIYATCH
  SHOP, Neighborhoodcircle) is lost except in Purchase notes; it decides
  returns and warranty routing. A small `sellerName` on Purchase or Expense
  is enough — do not mint a Vendor per marketplace seller. The
  [purchase import redesign](plans/purchase-import-redesign.md) captures
  `seller` per extracted line; land the column with that writer.

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

### Waiting for a trigger

- **Shortcode prefixes of 2–5 letters** — Promote with the first entity that
  wants a readable prefix. The `XXX-` shape is asserted in six places
  (`scripts/generator/entities/compile.ts`, `EntityCatalogTests.swift`,
  `test-support/identifiers.unit.test.ts`,
  `mcp/entity-kernel.integration.test.ts`, the README prefix table, the MCP
  instructions); the parser splits on the first dash and the column is
  `text`, so nothing else cares.

- **Data-exception fingerprints scoped to check inputs** — Promote when a
  "never available" exception is reopened by an unrelated edit in practice.
  Today the fingerprint is `<check>:<updatedAt>`, so assigning a project or
  editing notes re-questions an `unavailable` document; hashing the inputs
  the check reads (expense count, document set, `orderId`) would reopen it
  only when evidence changes.

- **`get_vendor_coverage` per account** — Promote when two members hold
  accounts at the same vendor. Coverage and `needs_data` are per Vendor
  today, which would conflate their histories.

- **Make hosted Actions the authoritative PR gate if the repository becomes
  public again.** Turn the existing manual CI workflow into required exact-head
  PR checks and keep its Linux lanes parallel: repository validation, auxiliary
  packages, Rust, web tests/build, PostgreSQL, and Chromium/WebKit E2E. Add the
  Apple gate on a standard macOS runner after the shared Rust/FFI artifact is
  available; it should run alongside the web lanes, not after them. Target a
  4–7 minute warm critical path and no more than 10 minutes cold. Once hosted
  checks are trustworthy, reduce routine local pre-push work to the clean-tree
  guard plus affected static/fast tests, while retaining `verify:local:full` as
  an explicit escape hatch. Do not make the repository public for CI alone.

- **`PurchaseLine` SKU annotation** — Promote when store SKU, quantity, or unit-price
  detail is genuinely wanted. It is annotation only; `Expense` remains financial
  truth.

- **Aggregate range materiality** — Promote if always-on cost/calorie/weight ranges
  create visible noise; keep authored line ranges and collapse only immaterial
  aggregate spreads.

- **Before-drywall spatial capture** — Promote immediately when construction is
  scheduled; define the smallest room/wall-indexed photo packet before walls close.

- **Budget-aware MCP pagination** — Promote when a real tool result hits an output
  limit or is measurably too large; use stable keyset cursors and an explicit compact
  JSON byte budget.

- **Core native inventory experience.** Promote when everyday use of the native
  redesign exposes a specific inventory bottleneck. Deepen location-first browsing,
  stock comparison, capture/recount, and photo completion; introduce
  unit-aware steppers, bulk actions, or drag/drop only for a
  demonstrated workflow. Owners: `apps/apple/App/Shared/Browse`, `Capture`, and
  `Audit`; see [native design](../apps/apple/DESIGN.md).

- **Decode bytes in image verification** — Promote when a corrupt or fully transparent
  cover is next found by eye. `inspectImageFile`
  (`apps/web/src/server/services/image-integrity.ts`) checks magic bytes, header
  dimensions, byte length and sha256 but never rasterizes, so `verify_product_images`
  reports `verified` for files that will not render. A subagent citing the verify tool
  is therefore not proof of a good image.

- **Durable import checkpoints** — Promote when an import genuinely spans sessions
  and cannot resume from source keys plus normal MCP queries. Superseded in
  design by [the purchase import redesign](plans/purchase-import-redesign.md)
  (per-account cursor, resumable agent runs).

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
  workflow needs to write it. The generic editor has no native control for
  product `unitMappings`/`labelNutrition`, recipe `sections`/`yield`/`meta`,
  meal `recipes`, expense `beneficiaries`/`funders`/`sourceClaims`,
  ledgerTransfer `sourceClaims`, financialAccount `identity`/`sourceAliases`,
  or financialTransaction `sourceRefs`; those fields are silently left out of
  the native create/edit form (`EntityFieldControls.swift`).

- **Native workflow parity with web.** Promote when a recurring household task
  still requires switching to the web. Native already renders every manifest
  create/update through the generic editor, so the parity mechanism is a slot
  per workflow: port one complete detail/list slot or action loop at a time,
  preserving existing contracts and specialized behavior. Owners:
  `apps/apple/App/Shared` and the generated `EntityCatalog`; build/capability context
  lives in [the native README](../apps/apple/README.md).

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

- **Record the TestFlight build-number rule where the archive script lives** —
  Promote on the next rejected upload. ASC rejects a repeated
  `CURRENT_PROJECT_VERSION`; it must be bumped in `project.yml` (not the
  gitignored `.xcodeproj`) per upload, and neither `apps/apple/README.md` nor
  `scripts/apple.ts` says so yet.

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

- **Splitwise re-export dedupe** — Promote if the Coachella-era Splitwise rows
  are ever re-imported. That export carries no row id, so source keys were
  derived from date + description + cost; a later export with an edited
  description will not dedupe against the first import.

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

- **Household cash-flow projection.** A scenario input, not a synced entity:
  expected inflows (a vesting date, price, withholding) and the ledger's
  recurring outflows projected forward, calibrated against `SUM(Expense.cost)`
  history. Needs no schema change and no money-bearing table. Net worth and
  retirement stay out until the trusted-household tenet is amended for a
  time-series table as an explicit decision.

- **House timeline.** A chronological house journal with project milestones,
  before/after photos, and an annual wrapped-style view over existing records.
  Build on the generic `resources.<entity>.timeline` capability rather than a
  bespoke aggregation.

- **Receipt-shaped import.** Move the deterministic half of a vendor import
  server-side: a `create_purchase_with_lines` (or `import_vendor_orders`)
  call takes a header plus lines with per-order defaults, dedupes on
  `orderId`, emits the typed tax/fee/tip/discount rows, and attaches the
  line's image URL — returning only the lines whose Product identity is
  ambiguous. Today the model spends ~150 tool calls per 16 orders on that
  mechanical part and ~20 on the judgment part. (The original wording had
  the writer refuse on `statedTotal`; tenet 5 forbids that — the check
  belongs in extraction.) Designed in full, with the agent, Mac app browser
  bridge, and Problems surface around it, in
  [the purchase import redesign](plans/purchase-import-redesign.md).

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

- **Register the household's other payment instruments.** Every card or bank
  account either member pays vendors with belongs in Cubby as a
  `FinancialAccount`, or its statement rows can never settle anything. Add the
  missing ones with aliases before the next statement import.

- **Settle the bare card charges.** 618 posted `purchase`-kind transactions
  ($38.6k) plus 31 refunds and 8 income rows have no Purchase allocation as of
  2026-09-14; the 22 sole-charge mismatches are a separate short list. Work
  from `/finance` with the purchase-presence filter set to none, matching to
  existing Purchases before booking new ones (`match_expenses`,
  `suggest_financial_transfer_pairs`). The 147 lump-line orders are a lower
  tier: itemize only where a receipt is on hand.

- **Ingest the Duboce Beds 2026–27 plan with `garden-plan-import`.** Turn the
  household's written seasonal plan into Locations, one season Project,
  due-dated Tasks, and planned Plantings by following the skill's playbook.
