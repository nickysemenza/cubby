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

1. **Ingredient detail editing and recipe-usage repair.** Make the ingredient
   detail page self-sufficient: edit `naKinds`, manage its product/USDA and
   price/unit-mapping relationships, and reparse an affected recipe line without
   opening the recipe form or ingredient workbench. Use this representative
   workflow to deepen the shared editing module only after its concrete needs are
   proven; do not add speculative editor ports first.

2. **Recurring maintenance tasks.** Add simple every-N-weeks/months recurrence;
   completing an instance creates the next one, which naturally enters Needs
   Attention. Cover every completion path with one idempotent transactional rule,
   not a scheduler or RRULE system.

3. **Manual shopping items with durable checks.** Give the shopping list
   server-backed item identity so ad-hoc entries such as milk or paper towels and
   checked state persist across date ranges and devices. Keep the list independent
   of inventory writes.

4. **Duplicate a meal or copy last week.** Add the remaining calendar round-trip
   shortcuts for repeating an individual meal or a prior week without rebuilding
   it by hand.

5. **Actionable meal suggestions.** Link missing ingredients to their repair
   surface, allow adding shortfalls to the shopping list, and make Suggestions
   reachable from inventory as well as navigation.

6. **Recipe nutrition MCP projection.** Add
   `get_recipe_nutrition(recipeId, servings)` over the existing recipe totals and
   return explicit mapped/unmapped coverage rather than silently presenting a
   partial total as complete.

7. **Ingredient coverage visibility.** Surface nutrition/cost coverage quality on
   the ingredient list so heavily used ingredients without a usable Product mapping
   are easy to find and repair.

8. **Guided placement pass for unlocated products.** Walk a value- or
   category-bounded worklist one product at a time with three answers: not tracked,
   place here, or skip. Reuse the existing location picker and immediate-write
   inventory flows.

9. **Cookbook metadata editing.** Allow imported cookbook titles and other source
   metadata to be corrected after import, including malformed OPF titles.

10. **Variance-targeted recount pass.** Seed a recount session from the
    shelf-versus-ledger disagreement worklist so the pass visits the products that
    actually disagree wherever they live.

11. **Project materials and shortfalls.** Add a project-material edge with quantity,
    free-text unit, optional Product resolution, and durable/consumable semantics;
    derive have/need/buy through the availability engine without reservations or
    automatic inventory decrement.

12. **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
    by giving cookbooks durable identity plus a merge/repoint path.

13. **Cookbook browsing.** Add search, sorting, and a browsable/filterable subjects
    facet. Partial-import repair stays on the existing Problems worklist.

14. **Recurring meals.** Add a focused recurrence model for meals as its own slice,
    separate from templates and nutrition goals.

15. **Meal templates.** Save reusable meal compositions without coupling them to
    recurrence.

16. **Meal nutrition goals.** Let meal planning compare planned nutrition with
    explicit household goals using the existing recipe nutrition totals.

17. **Fix Meals table filtering.** Move filtering to the server-backed list path so
    a paginated client page never presents itself as the complete filtered result.

18. **Fix actions for financial duplicate findings.** Give duplicate transaction
    source-ref and account-alias Problems findings a safe targeted action, without
    widening the general entity-merge system to money entities.

19. **Saved user-created views.** Persist named filter and sort sets using the
    versioned external-state pattern, and render them alongside manifest-defined
    views without creating a second query language.

20. **Server-backed table intelligence.** Extend exact facet counts and honest
    aggregate summaries from Expenses to one justified server-paginated surface at
    a time; never analyze a partially loaded client page as the full population.

21. **Return parsed lines from recipe scraping.** Fold ingredient parsing into
    `parse_scraped_recipe` so imports do not cross the WASM boundary a second time
    for the same lines.

22. **Reconsider the remaining USDA MCP App.** The Shopping List App is gone;
    `get_shopping_list` is a plain structured/text tool. The remaining USDA
    Picker template is 352,004 bytes raw / 83,655 gzip and builds in 132 ms on
    the local M3 development machine. Keep it only while refinement and explicit
    selection materially outperform a plain `search_usda_foods` result.

---

## Triggered

- **Native iOS/macOS app beyond the proof of concept** — Promote screen porting,
  App Intents, widgets, and TestFlight once the `apps/apple` vertical slice
  proves its four unknowns: bearer sign-in against Better Auth, generated
  `swift-openapi-generator` client sources against Cubby's OpenAPI doc,
  `cubby-ffi` (UniFFI) ingredient parsing on-device, and VisionKit/Vision
  barcode + cover-image scanning. See [apps/apple/README.md](../apps/apple/README.md)
  for build order and ownership; removing the React scanner/PWA share target
  waits for the native audit flow to reach parity.

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
- **Measured table-virtualizer investigation** — Revisit `directDomUpdates`
  only during a measured desktop table-virtualizer investigation.
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
  each occurrence must stay a distinguishable shopping-list contribution (see
  `api/routers/meal.integration.test.ts`). Retry-safety needs a caller-supplied key.
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
