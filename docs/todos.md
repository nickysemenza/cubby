# Cubby — Work List

The canonical backlog. The **Ranked backlog** is one global order: if choosing
the next Cubby project today, start at the top. Rank reflects real-use friction,
urgency, enabling leverage, and the fact that this is a personal project where
interesting work has legitimate value. Reorder it whenever actual use changes.

**Triggered** items are not ranked until their stated evidence appears.
**Visions** preserve desirable directions without pretending they are ready
implementation slices. **Operational passes** are household data work, not
software projects.

Keep entries concise and outcome-oriented. Record only constraints that would
change selection or implementation, with a pointer to the code or focused doc
that owns the full contract. Shipped and superseded work leaves this file; git
history is the archive. Permanent product constraints live in the
[Tenets](../README.md#tenets), not in rejected-idea essays here.

---

## Ranked backlog

- **Ingredient detail editing and recipe-usage repair.** The ingredient detail
  page already hosts product/USDA (`IngredientProductShelf`) and unit-mapping
  (`UnitCoveragePanel`) sections. Remaining scope: let `naKinds` be edited
  after creation (currently create-only), and add a reparse action to the
  recipe-usage drift indicator, which is presently read-only. Use this
  representative workflow to deepen the shared editing module only after its
  concrete needs are proven; do not add speculative editor ports first.

- **Recurring maintenance tasks.** Add simple every-N-weeks/months recurrence;
  completing an instance creates the next one, which naturally enters Needs
  Attention. Cover every completion path with one idempotent transactional rule,
  not a scheduler or RRULE system.

- **Manual shopping items with durable checks.** Give the shopping list
  server-backed item identity so ad-hoc entries such as milk or paper towels and
  checked state persist across date ranges and devices. Keep the list independent
  of inventory writes.

- **Duplicate a meal or copy last week.** Add the remaining calendar round-trip
  shortcuts for repeating an individual meal or a prior week without rebuilding
  it by hand.

- **Actionable meal suggestions.** `/meals/suggestions` is already reachable
  from navigation. Remaining scope: link missing ingredients to their repair
  surface, allow adding shortfalls to the shopping list, and add an entry
  point from inventory.

- **Recipe nutrition MCP projection.** Add
  `get_recipe_nutrition(recipeId, servings)` over the existing recipe totals and
  return explicit mapped/unmapped coverage rather than silently presenting a
  partial total as complete.

- **Ingredient coverage visibility.** The ingredient list already shows a USDA
  badge, a recipe-usage-count column, and a binary has/none product-presence
  filter. Remaining scope: a combined, mapping-quality-aware signal/filter
  that surfaces heavily used ingredients lacking a usable Product mapping
  specifically, not just ones with no Product at all.

- **Guided placement pass for unlocated products.** Walk a value- or
  category-bounded worklist one product at a time with three answers: not tracked,
  place here, or skip. Reuse the existing location picker and immediate-write
  inventory flows.

- **Cookbook metadata editing.** Allow imported cookbook titles and other source
  metadata to be corrected after import, including malformed OPF titles. Cookbook
  is still write-once in the entity kernel (`bindings.unit.test.ts` asserts
  `updateInput` is null), and a recipe's cookbook link cannot be re-pointed from
  the recipe form even though the generated update field group already permits
  `cookbookId` — wire both in the same slice.

- **Variance-targeted recount pass.** Seed a recount session from the
  shelf-versus-ledger disagreement worklist so the pass visits the products that
  actually disagree wherever they live.

- **Project materials and shortfalls.** Add a project-material edge with quantity,
  free-text unit, optional Product resolution, and durable/consumable semantics;
  derive have/need/buy through the availability engine without reservations or
  automatic inventory decrement.

- **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
  by giving cookbooks durable identity plus a merge/repoint path.

- **Cookbook browsing.** Add search, sorting, and a browsable/filterable subjects
  facet. Partial-import repair stays on the existing Problems worklist.

- **Recurring meals.** Add a focused recurrence model for meals as its own slice,
  separate from templates and nutrition goals.

- **Meal templates.** Save reusable meal compositions without coupling them to
  recurrence.

- **Meal nutrition goals.** Let meal planning compare planned nutrition with
  explicit household goals using the existing recipe nutrition totals.

- **Fix actions for financial duplicate findings.** Give duplicate transaction
  source-ref and account-alias Problems findings a safe targeted action, without
  widening the general entity-merge system to money entities.

- **Saved user-created views.** Persist named filter and sort sets using the
  versioned external-state pattern, and render them alongside manifest-defined
  views without creating a second query language.

- **Server-backed table intelligence.** Extend exact facet counts and honest
  aggregate summaries from Expenses to one justified server-paginated surface at
  a time; never analyze a partially loaded client page as the full population.

- **Return parsed lines from recipe scraping.** Fold ingredient parsing into
  `parse_scraped_recipe` so imports do not cross the WASM boundary a second time
  for the same lines.

- **Reconsider the remaining USDA MCP App.** The Shopping List App is gone;
  `get_shopping_list` is a plain structured/text tool. The remaining USDA
  Picker template is 352,004 bytes raw / 83,655 gzip and builds in 132 ms on
  the local M3 development machine. Keep it only while refinement and explicit
  selection materially outperform a plain `search_usda_foods` result.

---

## Triggered

### Garden audit follow-ups (2026-09-14)

- (P3) **Bulk "Finish selected" on Apple.** Web has no equivalent gap; the
  native client lacks a multi-select finish action for plantings, so
  finishing several plantings at once still means one Finish per planting.
- (P3) **Ingredient merge drops `gardenGuideKey`.** Merging two Ingredients
  silently discards the losing Ingredient's `gardenGuideKey` rather than
  carrying or surfacing it. Separately, Product merge can leave a Planting
  pointed at the tombstoned source Product without surfacing that planting in
  the merge preview.
- (P3) **Planting/entry delete is API/MCP-only.** No web or Apple UI
  affordance calls delete for `planting` or `gardenEntry` today; decide
  whether one is wanted before adding it.
- (P3) **Apple day-grouped photo import is reachable only from Photos › Add
  to….** The generic "attach to Plantings / Garden Entries" chooser bypasses
  journal semantics (anchor locking, area journal placement) since it doesn't
  route through the garden entry form.
- (P3) **`/locations/arrange` and `/locations/photo-pass` ignore growing
  areas.** Neither existing bulk-location tool is garden-aware.
- (lead) **React #418 hydration error on `/garden` and `/garden-entries`.**
  Logged in production on both route loads; reproduce in dev before deciding
  on a fix.
- (idea) **Guide planting windows as a calendar overlay.** Render the
  Planting guide's reference windows on top of the garden calendar lane
  instead of as a separate lookup.
- (P3) **`EntityInlineLink` lacks cases for `financialAccount`,
  `financialTransaction`, `wish`, and `image`.** Unrelated to garden directly,
  but found auditing generic entity-link rendering during this pass.
- (P3) **`usda-food` uses the status-green `INK.positive` entity color.**
  Same audit pass; the color reads as a status signal rather than an entity
  identity color.
- (P3) **Apple `MappingTests` meal-name fallback is now a separate
  client-side rule.** Since `meal` carries a server-computed `displayName`,
  the Apple-side fallback name logic in `MappingTests` duplicates the
  contract rather than reading the server value.
- (P3) **`FormWrapper` renders its action bar in the dialog body.**
  `apps/web/src/app/_components/form-utils.tsx`'s `FormWrapper` has no footer
  mode, so `settle-expense` and `create-project-from-tasks` can't render
  their actions in `ResponsiveDialog`'s footer the way every other dialog
  does. Add a footer mode so those two forms can adopt it.

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

- **Move the UPC-batch detector out of the problem-count badge** — Promote if
  the badge's refresh-behind-read ever shows up in request timings: one detector
  (`productsWithBetterUpcData`) calls the external UPC lookup, so the badge
  refresh is not pure SQL. Moving it to the coverage page (computed on that
  page's load) keeps the badge cheap without losing the detector.

- **Native iOS/macOS app beyond the proof of concept** — Promote screen porting,
  App Intents, widgets, and TestFlight once the `apps/apple` vertical slice
  proves its four unknowns: bearer sign-in against Better Auth, generated
  `swift-openapi-generator` client sources against Cubby's OpenAPI doc,
  `cubby-ffi` (UniFFI) ingredient parsing on-device, and VisionKit/Vision
  barcode + cover-image scanning. See [apps/apple/README.md](../apps/apple/README.md)
  for build order and ownership; removing the React scanner/PWA share target
  waits for the native audit flow to reach parity. Still queued after the
  Search tab, universal links, shelf overlay, and quick actions landed: NFC bin
  tags (an NDEF record holding the label URL launches the app through the AASA
  with no code), decoding a barcode from a photo (VisionKit `ImageAnalyzer`,
  which also makes scan flows testable on the simulator), printing a label from
  a location or product, a recipe cooking mode, and the widget / Control Center
  scan control / Live Activity / share-extension set that needs the App Group
  and Keychain access-group plumbing.

- **Exact nutrition source tracing** — Resume when upstream conversion work is in
  scope. Extend `ingredient-parser` reports to retain actual mapping identities,
  directions, and competing mappings from the selected calculation path. Then
  update Cubby and expose Product/USDA/manual-mapping provenance through nutrient
  cells and nested recipes, including consumption and yield adjustments. Show
  selected results with conflicting alternatives and repair links, preserving
  existing resolution rules. Return inspected values and traces from the same
  computation; never infer selected sources from matching values or linked-product
  lists. The Cubby-only nutrition overhaul does not depend on this work.

- **TanStack Start observability** — Remove Cubby's observability wrapper when
  TanStack Start supplies equivalent named request/result/error events and trace
  hooks: <https://tanstack.com/start/latest/docs/framework/react/guide/observability>.
- **Measured table-virtualizer investigation** — Revisit direct-DOM-write
  virtualizer options only during a measured desktop table-virtualizer
  investigation (re-check `@tanstack/react-virtual`'s current API for a
  low-render-overhead update mode; the option this line previously named,
  `directDomUpdates`, no longer exists in the installed version).
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
- **Entity relation runtime dispatch** — Promote when attach/detach genericization
  resumes. Generate dispatch only for declared runtime ports and make unsupported
  semantic edges fail explicitly; catalog relationships must not imply executable
  mutation behavior.
- **Natural CI evidence** — Revisit sharding only when ordinary exact-head runs
  show a repeatable tail imbalance or regression. Use native reporter output;
  do not add duration databases, custom sequencers, or manufactured timing runs.
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
- **Aggregate range materiality** — Promote if always-on cost/calorie/weight ranges
  create visible noise; keep authored line ranges and collapse only immaterial
  aggregate spreads.
- **USDA duplicate collapsing** — Promote if repeated UPC versions return to useful
  search pages; reuse `dedupeUsdaFoodsByUpc` in the MCP handler rather than changing
  usda-api pagination semantics.
- **Product external-ID collision worklist** — Promote a broader Problems surface if
  auto-minting imports create a persistent operator queue beyond the existing
  `product.externalIdCollisions` query.
- **Residual N+1 repair** — Promote only when a fresh network trace finds a concrete
  products, recipes, or inventory-detail query fan-out.
- **Sentry lazy initialization** — Promote if a fresh bundle treemap shows Sentry is
  still a material critical-path dependency.
- **Shopping pack rounding** — Promote when a real shopping workflow needs it and a
  representative purchasable Product/pack mapping has an explicit selection rule.
- **Location subtree filters** — Promote when direct-child filtering demonstrably
  blocks a location or inventory workflow; use a scoped descendant-id helper rather
  than the relation-heavy whole-tree CTE.
- **`PurchaseLine` SKU annotation** — Promote when store SKU, quantity, or unit-price
  detail is genuinely wanted. It is annotation only; `Expense` remains financial
  truth.
- **Multi-product Expense links** — Promote when one Expense genuinely needs several
  Products and `splitExpense` cannot truthfully split the money.
- **Estimated-allocation analytics caveat** — Promote when materials-versus-labor
  analytics inform a real decision; disclose the allocation-basis portion without
  excluding it from total spend.
- **Services-with-product advisory** — Promote when the first live row appears or an
  import repeatedly creates one; keep it advisory rather than a database constraint.
- **Repeat-purchase ranking** — Promote when enough Products have genuine repeated
  acquisitions to make a cross-product ranking useful.
- **Returned-unit price advisory** — Promote when another stocked Product has a
  materially inflated derived price or a structural signal can distinguish returns
  from sales. Keep the response advisory until that distinction is reliable; an
  ambiguous heuristic must not silently rewrite valuation.
- **Purchase evidence references** — Promote when Gmail, Drive, or portal evidence
  must be queried repeatedly beyond Purchase notes and attached documents.
- **Durable import checkpoints** — Promote when an import genuinely spans sessions
  and cannot resume from source keys plus normal MCP queries.
- **Purchase replacement/exchange relations** — Promote when those relationships
  need navigation or querying rather than truthful Purchase notes.
- **Before-drywall spatial capture** — Promote immediately when construction is
  scheduled; define the smallest room/wall-indexed photo packet before walls close.
- **Production query-cost repair** — Promote the specific offender confirmed by a
  fresh production trace, including a Problems count-only path or whole-catalog
  purchase aggregates; remeasure before restructuring counters.
- **Selective SSR expansion** — Promote another route family only if the
  product-detail pilot wins a cold-cache browser comparison without an INP, CLS, or
  Worker-error regression.
- **Selection-control consolidation** — Promote a specific selector family when
  visual or keyboard inconsistency becomes painful; preserve specialized interaction
  contracts rather than forcing one universal control.
- **Budget-aware MCP pagination** — Promote when a real tool result hits an output
  limit or is measurably too large; use stable keyset cursors and an explicit compact
  JSON byte budget.
- **Generated eager-route filter mirrors** — Promote if a third schema mirror
  appears; generate build-time projections rather than importing validation graphs
  into the eager route tree.
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
- **Explicit idempotency key for `add_recipe_to_meal`** — Promote if a re-sent agent
  call actually duplicates a meal line in practice. A natural-key unique index is NOT
  the answer: a meal repeating a recipe at different scales is intended behavior, and
  each occurrence must stay a distinguishable shopping-list contribution. Retry-safety
  needs a caller-supplied key. The guard test that named this as intentional was
  deleted with the tRPC-era `meal.integration.test.ts` (#914) and never replaced, so
  the first slice of this — or of any meal-line work — is a `workflows/meal.server.ts`
  integration test asserting one meal holds one recipe twice at different scales with
  two independent shopping-list contributions.
- **Decode bytes in image verification** — Promote when a corrupt or fully transparent
  cover is next found by eye. `inspectImageFile`
  (`apps/web/src/server/services/image-integrity.ts`) checks magic bytes, header
  dimensions, byte length and sha256 but never rasterizes, so `verify_product_images`
  reports `verified` for files that will not render. A subagent citing the verify tool
  is therefore not proof of a good image.
- **Match book scans against ledger-imported books** — Promote when the next ISBN scan
  mints a twin. `findOrCreateByISBN` (`product-orchestration.service.ts`) matches on GTIN
  only, and Products created by the eBay/Amazon ledger imports carry no ISBN, so a scan
  duplicates a book that already has purchase history; the merge that follows is lossy.
  Either backfill ISBNs onto import-created book Products from their external ids, or
  fall back to a title/author match before creating.
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
- **Promote harvested equivalences into the unit graph** — Promote when the
  ingredient equivalences report's suggestions are repeatedly re-applied by hand. The
  report (`lib/harvest-equivalences.ts`, `ingredients/equivalences-report.tsx`)
  harvests ingredient-scoped unit equivalences from recipe parentheticals on demand;
  writing an accepted one into a durable ingredient-level unit mapping is the deferred
  next step, and there is no such store yet.
- **Per-edge breakdown for purchase merges** — Promote if `merge_entity`'s empty
  `moved` array on purchase is noticed in use. `foldChargeInto` moves expenses and
  documents without counting them, so purchase reports a measured `merged` count but
  no per-edge detail, unlike the other three merge entities.
- **Exact entity attribution for `attach_files`** — Promote if mixed-entity batches
  distort the MCP usage dashboard. The batch attributes telemetry to its first item's
  entity because one row has nowhere to put a set; a batch spanning entities
  under-reports the rest.
- **Harden `createDeleteProcedure`'s id contract** — Promote if a second hand-rolled
  delete procedure appears. It infers its id type from the callback and then casts
  (`id as TId`), so a branded parameter alone does not catch a caller passing the
  wrong id form — that is how shortcode-vs-uuid image deletion shipped to review.
  Every entity going through `createEntityCrudRouter` is safe today because that
  config requires an `idSchema`; a hand-rolled call site can still omit one.

---

## Visions

- **Recipe scaling extensions.** Explore pan-size targets, interactive parse
  clarification, and baker's-percentage comparison without replacing Product-owned
  density mappings with a global reference table.
- **House timeline.** A chronological house journal with project milestones,
  before/after photos, and an annual wrapped-style view over existing records.
- **Household balance sheet.** Generalize location valuation into replacement
  forecasts, cost-per-project analysis, and insurance or cost-basis exports.
- **Ambient capture.** Accept voice memos, forwarded email, shared photos, and NFC
  entry points so reality reaches Cubby with minimal ceremony.
- **Standing household agents.** A registrar for records, quartermaster for
  consumable shortfalls, and foreman for stale or blocked projects, with approval
  before durable writes.
- **Digital twin and spatial memory.** Attach shutoffs, breaker maps, paint, hidden
  utilities, and other building knowledge to the location tree.
- **Grow-to-table loop.** Model beds and plantings, receive harvests into pantry
  inventory, and ask what the yard can supply this week.
- **Heirloom outputs.** Produce a future-owner house manual, project yearbooks, and a
  durable archive/export format.
- **Home Assistant to Cubby.** Turn runtime, energy, fault, weather, and area/device
  signals into maintenance, project evidence, and correctly scoped tasks.
- **Cubby to Home Assistant.** Expose computed shopping shortfalls, maintenance due,
  actionable weekend work, and tonight's meal for household display and voice.

---

## Operational passes

- **Fill ingredient density gaps.** Use the existing missing-weight list to add
  Product `UnitMapping` data organically as ingredients need it.
- **Fill missing acquisition quantities.** Work through Expenses → Missing quantities
  and record known counts on existing Product-linked acquisition rows; do not freeze
  a changing row count into this file.
