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

6. **EPUB recipe hero photos.** Carry recipebridge's in-archive `ImageRef` through
   import, materialize the bytes into R2, and attach the image to the recipe in the
   same synchronous cookbook-import request.

7. **Recipe nutrition MCP projection.** Add
   `get_recipe_nutrition(recipeId, servings)` over the existing recipe totals and
   return explicit mapped/unmapped coverage rather than silently presenting a
   partial total as complete.

8. **Ingredient coverage visibility.** Surface nutrition/cost coverage quality on
   the ingredient list so heavily used ingredients without a usable Product mapping
   are easy to find and repair.

9. **Guided placement pass for unlocated products.** Walk a value- or
   category-bounded worklist one product at a time with three answers: not tracked,
   place here, or skip. Reuse the existing location picker and immediate-write
   inventory flows.

10. **Cookbook metadata editing.** Allow imported cookbook titles and other source
   metadata to be corrected after import, including malformed OPF titles.

11. **Variance-targeted recount pass.** Seed a recount session from the
    shelf-versus-ledger disagreement worklist so the pass visits the products that
    actually disagree wherever they live.

12. **Project materials and shortfalls.** Add a project-material edge with quantity,
    free-text unit, optional Product resolution, and durable/consumable semantics;
    derive have/need/buy through the availability engine without reservations or
    automatic inventory decrement.

13. **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
    by giving cookbooks durable identity plus a merge/repoint path.

14. **Cookbook browsing.** Add search, sorting, and a browsable/filterable subjects
    facet. Partial-import repair stays on the existing Problems worklist.

15. **Recurring meals.** Add a focused recurrence model for meals as its own slice,
    separate from templates and nutrition goals.

16. **Meal templates.** Save reusable meal compositions without coupling them to
    recurrence.

17. **Meal nutrition goals.** Let meal planning compare planned nutrition with
    explicit household goals using the existing recipe nutrition totals.

18. **Fix Meals table filtering.** Move filtering to the server-backed list path so
    a paginated client page never presents itself as the complete filtered result.

19. **Fix actions for financial duplicate findings.** Give duplicate transaction
    source-ref and account-alias Problems findings a safe targeted action, without
    widening the general entity-merge system to money entities.

20. **Saved user-created views.** Persist named filter and sort sets using the
    versioned external-state pattern, and render them alongside manifest-defined
    views without creating a second query language.

21. **Server-backed table intelligence.** Extend exact facet counts and honest
    aggregate summaries from Expenses to one justified server-paginated surface at
    a time; never analyze a partially loaded client page as the full population.

22. **Return parsed lines from recipe scraping.** Fold ingredient parsing into
    `parse_scraped_recipe` so imports do not cross the WASM boundary a second time
    for the same lines.

23. **Consider deleting tRPC after the Entity Kernel ships.** The 2026-08-24
    detail/list/filter/write migration leaves 263 dedicated transport lines,
    189 production `useTRPC` imports, 212 query-option call sites, and 59
    mutation-option call sites. Named generic CRUD writes, `entity.query`, and
    `entity.mutate` have all been deleted; remaining mutations are workflows or
    specialized operations. tRPC still provides streamed batches capped at 50,
    SuperJSON, middleware/error formatting, SSR's
    in-process link, and shared cancellation/invalidation helpers. Follow the
    measured criteria in **TanStack Start and transport** below rather than
    deleting it for dependency count alone.

24. **Reconsider the remaining USDA MCP App.** The Shopping List App is gone;
    `get_shopping_list` is a plain structured/text tool. The remaining USDA
    Picker template is 352,004 bytes raw / 83,655 gzip and builds in 132 ms on
    the local M3 development machine. Keep it only while refinement and explicit
    selection materially outperform a plain `search_usda_foods` result.

---

## TanStack Start and transport

- Migrate additional route-owned reads when they do not benefit from batching;
  keep public/external endpoints as server routes rather than Start functions.
- Retain the Inventory, Project, Task, Expense, Purchase, and Financial Account
  list adapters while their embedded views and selector clusters benefit from
  tRPC batching. Reconsider them from ordinary operation traces, or when Start
  supplies a native batching facility; do not build a parallel batch transport.
- Measure browser request count and route-ready time before moving Home or
  dashboard reads. Do not trade one batch for a visible request fan-out.
- Measure the Start generic-write migration's invalidation, optimistic rollback,
  error serialization, cancellation, and deployment-overlap behavior before
  moving workflow writes. Old tabs from the pre-migration deployment must reload
  before issuing a generic write; no compatibility procedure remains.
- Reconsider streamed workflows only after Start has equivalent semantic logging,
  cancellation, trace propagation, and incremental-result behavior.
- Reconsider deleting tRPC only when its remaining middleware, batching,
  streaming, SuperJSON, SSR-local transport, and debugging value is negligible.
- Track upstream automatic observability support and remove Cubby's Start wrapper
  when the framework supplies equivalent named request/result/error events and
  trace hooks: <https://tanstack.com/start/latest/docs/framework/react/guide/observability>.

---

## Triggered

- **Entity relation runtime dispatch** — Promote when attach/detach genericization
  resumes. Generate dispatch only for declared runtime ports and make unsupported
  semantic edges fail explicitly; catalog relationships must not imply executable
  mutation behavior.
- **Entity-runtime production proof** — Promote after a transport or preview
  deployment changes these contracts: verify Product-list traversal causes no
  speculative detail fan-out, `P-`/`L-` scans still canonicalize end to end, and
  Start mutations succeed from a freshly loaded production tab.
- **Natural CI evidence** — Revisit sharding only when ordinary exact-head runs
  show a repeatable tail imbalance or regression. Use native reporter output;
  do not add duration databases, custom sequencers, or manufactured timing runs.
- **Persisted Collections and operational dashboard** — Promote when Collection
  tags need metadata, rename-safe empty identity, Smart Collection rules (for
  example, manufacturer plus minimum effective price), Trade links, or combined
  Project/Task/Expense views; migrate `collection:*` tags into durable records
  rather than layering on a parallel mapping. Smart membership should evaluate
  a saved Product filter at read time rather than auto-tagging matching records.
  Include Trade predicates derived from a Product's linked Expense lines (Trade
  belongs to each Expense, not its parent Purchase): support both “any
  historical Trade matches” for inclusive, overlapping Collections and a
  deterministic “primary inferred Trade matches” rule that reuses the existing
  Product-to-Trade inference rather than introducing a second derivation.
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
  exhaustive `Record<Entity, …>` tables. Follow `scripts/backfill-image-shortcodes.ts`;
  `generateUniqueShortcode` does a SELECT per candidate and is wrong for bulk.
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
