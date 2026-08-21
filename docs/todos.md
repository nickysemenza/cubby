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

1. **Retire `Product.upc`.** Barcodes are a scalar column, so a product can hold
   exactly one — every merge whose survivor already had a different barcode
   destroyed the other, and 127 soft-deleted products still carry one. The
   multi-valued half shipped (PR #829: `ProductExternalId.isPrimary`, `gtin`
   source, `upc_a`/`ean_13`/`ean_8`/`gtin_14` kinds); this is the contract half.
   Backfill 783 live UPCs into primary `gtin` rows, repoint every reader, then
   drop the column and `Product_upc_key`. Deliberately deferred, not forgotten:
   the read fan-out is ~65 files (filter manifest and sortable fields lose a
   scalar to sort and presence-filter on, `search-document` projects `upc` into
   `keywords` in TWO places, `semantic/text` embeds it, `detectors-product`
   groups duplicates by it) and it ends in a `DROP COLUMN` that needs its own
   deploy window. Rebuild search documents and embeddings after the cutover so
   the stale `upc` keyword stops doing the finding. `UpcLookupCache`,
   `packages/upc-contract`, and `routers/upc.ts` are the barcode LOOKUP service
   and are not affected.

2. **Ingredient detail editing and recipe-usage repair.** Make the ingredient
   detail page self-sufficient: edit `naKinds`, manage its product/USDA and
   price/unit-mapping relationships, and reparse an affected recipe line without
   opening the recipe form or ingredient workbench.

3. **Recurring maintenance tasks.** Add simple every-N-weeks/months recurrence;
   completing an instance creates the next one, which naturally enters Needs
   Attention. Cover every completion path with one idempotent transactional rule,
   not a scheduler or RRULE system.

4. **Manual shopping items with durable checks.** Give the shopping list
   server-backed item identity so ad-hoc entries such as milk or paper towels and
   checked state persist across date ranges and devices. Keep the list independent
   of inventory writes.

5. **Duplicate a meal or copy last week.** Add the remaining calendar round-trip
   shortcuts for repeating an individual meal or a prior week without rebuilding
   it by hand.

6. **Actionable meal suggestions.** Link missing ingredients to their repair
   surface, allow adding shortfalls to the shopping list, and make Suggestions
   reachable from inventory as well as navigation.

7. **EPUB recipe hero photos.** Carry recipebridge's in-archive `ImageRef` through
   import, materialize the bytes into R2, and attach the image to the recipe in the
   same synchronous cookbook-import request.

8. **Recipe nutrition MCP projection.** Add
   `get_recipe_nutrition(recipeId, servings)` over the existing recipe totals and
   return explicit mapped/unmapped coverage rather than silently presenting a
   partial total as complete.

9. **Ingredient coverage visibility.** Surface nutrition/cost coverage quality on
   the ingredient list so heavily used ingredients without a usable Product mapping
   are easy to find and repair.

10. **Guided placement pass for unlocated products.** Walk a value- or
   category-bounded worklist one product at a time with three answers: not tracked,
   place here, or skip. Reuse the existing location picker and immediate-write
   inventory flows.

11. **Cookbook metadata editing.** Allow imported cookbook titles and other source
   metadata to be corrected after import, including malformed OPF titles.

12. **Variance-targeted recount pass.** Seed a recount session from the
    shelf-versus-ledger disagreement worklist so the pass visits the products that
    actually disagree wherever they live.

13. **Project materials and shortfalls.** Add a project-material edge with quantity,
    free-text unit, optional Product resolution, and durable/consumable semantics;
    derive have/need/buy through the availability engine without reservations or
    automatic inventory decrement.

14. **Cookbook identity merge.** Stop same-title collisions and renamed-EPUB forks
    by giving cookbooks durable identity plus a merge/repoint path.

15. **Cookbook browsing.** Add search, sorting, and a browsable/filterable subjects
    facet. Partial-import repair stays on the existing Problems worklist.

16. **Recurring meals.** Add a focused recurrence model for meals as its own slice,
    separate from templates and nutrition goals.

17. **Meal templates.** Save reusable meal compositions without coupling them to
    recurrence.

18. **Meal nutrition goals.** Let meal planning compare planned nutrition with
    explicit household goals using the existing recipe nutrition totals.

19. **Fix Meals table filtering.** Move filtering to the server-backed list path so
    a paginated client page never presents itself as the complete filtered result.

20. **Fix actions for financial duplicate findings.** Give duplicate transaction
    source-ref and account-alias Problems findings a safe targeted action, without
    widening the general entity-merge system to money entities.

21. **Saved user-created views.** Persist named filter and sort sets using the
    versioned external-state pattern, and render them alongside manifest-defined
    views without creating a second query language.

22. **Server-backed table intelligence.** Extend exact facet counts and honest
    aggregate summaries from Expenses to one justified server-paginated surface at
    a time; never analyze a partially loaded client page as the full population.

23. **Return parsed lines from recipe scraping.** Fold ingredient parsing into
    `parse_scraped_recipe` so imports do not cross the WASM boundary a second time
    for the same lines.

24. **Consolidate duplicate entity detail reads.** Unify `getByID` and
    `getByShortcode` cache/read behavior only after preview consumers handle the
    differing missing-entity contracts explicitly.

---

## Triggered

- **Persisted Collections and operational dashboard** — Promote when Collection
  tags need metadata, rename-safe empty identity, Smart Collection rules (for
  example, manufacturer plus minimum effective price), Trade links, or combined
  Project/Task/Expense views; migrate `collection:*` tags into durable records
  rather than layering on a parallel mapping. Smart membership should evaluate
  a saved Product filter at read time rather than auto-tagging matching records.
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
