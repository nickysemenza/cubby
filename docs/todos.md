# Cubby — Work List

The canonical backlog. The **Triage board** is the execution queue; the domain
catalog below carries the load-bearing detail. An unchecked box in the catalog
means "valid idea," not "equally urgent." Anything not promoted to **Now** or
**Next** is Later by default.

Design decisions and rejected alternatives live next to the items they concern
(there is no separate plans directory — detail beyond what an item carries here
gets re-derived at build time, against the code as it exists then).

Everything here is bounded by the [Tenets](../README.md#tenets). An idea that
contradicts one belongs in a **Rejected** block, not in the open list.

---

## Triage board

### Now

Keep **Now** deliberately small. Promote at most one catalog item here when work
starts.

_No item is currently promoted._

### Next

Ordered within each domain only; choose based on which surface is seeing real use.

- **Recipe data:** ingredient editing parity, then macro-aware nutrition. The
  portion solver stays behind nutrition and real evidence that agent iteration is
  painful.
- **Shopping:** finish Shopping list v1.6 with manual/ad-hoc items + durable
  check-off, pack rounding, then cross-device check-off.
- **House:** recurring maintenance.
- **Engineering:** keep symmetry-only refactors behind live correctness or
  maintenance work.

### Promote only when triggered

These are recorded options, not latent obligations. Their detailed entries name
the evidence required before promotion.

- UPC duplicate collapsing, aggregate-range materiality, Sentry lazy-init,
  selective-SSR expansion, selection-control consolidation, budget-aware MCP
  pagination, and all three additional MCP Apps.
- `PurchaseLine`, `ExpenseProduct`, the service/product advisory, the
  returned-unit price advisory, and repeat-purchase ranking.
- Product external-id collisions are **already queryable** through
  `product.externalIdCollisions`; revisit a broader Problems surface only if an
  auto-minting import creates a persistent operator worklist.
- Fix the meals table's client-side filtering on the next meals-table touch;
  codegen the eager-route filter mirrors only if a third mirror appears.
- The location identity-product image fallback on the tree-fed surfaces
  (gallery, card grid, arrange) — it needs a `makeTree` join to do anything at
  all, so adding the call alone is a silent no-op.
- The before-drywall spatial-memory capture is the exception: promote it
  immediately when construction timing makes that deadline real.

### Triage rules

- A shipped item leaves this file; git history and code tests are the archive.
- A bundle that cannot ship atomically gets split before promotion.
- "Optional," "only if it resurfaces," and explicit **Trigger** items do not enter
  **Now** without the stated evidence.
- Rejected ideas stay recorded so they do not cycle back through planning.

---

## Recipes & Import

### MCP recipe authoring (from real-use feedback)

Follow-ons to the batch `resolve_ingredients` + `create_recipe_from_text` MCP tools
(shipped 2026-06-15; the prep-sheet export also shipped, as the recipe-detail
prep/nested/matrix views + the `/recipes/$id/export` print route).

- [ ] **Portion solver**: a tool that takes a recipe + macro constraints (e.g. `<850
  kcal, >60g protein`, "lighter for person X") and solves the component gram weights in
  one shot, instead of the agent hand-iterating amounts. Niche; largely subsumed by the
  agent once macro-aware nutrition (below) makes macros queryable via a
  `get_recipe_nutrition(recipeId, servings) → {P,F,C,kcal}` tool. Build only if the
  iterate-and-recheck loop stays painful in practice.
- [ ] **Macro-aware nutrition (prereq for the above)**: surface P/F/C/kcal per serving
  by resolving `ingredient → product → fdc_id` — the hop stays, per
  [tenet 2](../README.md#tenets); `fdc_id` is **not** getting an ingredient-level
  column. Work is therefore: pick the representative product for an ingredient that
  has several, auto-attach a best-guess product/FDC entry during resolve-or-create,
  and render an explicit "unmapped ingredient" state rather than a silently-wrong
  total. Then expose `get_recipe_nutrition(recipeId, servings) → {P,F,C,kcal}`.

### Recipe scaling — density coverage (Phase 2)

Follow-on to client-side recipe scaling (multiplier/weight/ingredient anchors,
`recipe-scaling.ts` + `RecipeScaleControl.tsx`). No new schema/table — fix data
organically via the existing per-product `UnitMapping` mechanism — fill in a
density when an ingredient shows up in a recipe's missing-weight list. Salts are
done; bare "salt" stays aliased to Diamond Crystal.

Parked: pan-size scaling, a global density reference table/seed, interactive
parse-clarification, and the baker's-% compare "X-ray".

- [ ] **Ingredient detail editing parity** (2026-07 audit): the detail page
  can't do what the workbench can — no `naKinds` toggles, no inline USDA link,
  no price entry; "Appears In Recipes" shows parse drift with no per-line
  re-parse (that button exists only inside the recipe form). Ingredient list
  has no coverage-quality column or "used in N recipes, no product" filter.

### Amount-range aggregate materiality threshold

Amount ranges ("2–3 cups") now propagate everywhere (line + totals + list +
compare). Line-level ranges are always shown (authored data). The open question
is aggregate noise: a trivial spread from one tiny ingredient widens a whole
recipe to "$2.14 – $2.26", which costs column width on dense surfaces for ~no
decision value.

- [ ] **Materiality threshold on aggregate ranges only**: render a recipe total
  (cost/calories/weight on the detail headline, list, and compare) as a range
  only when the spread is meaningful — e.g. `upper - lower` exceeds some % of the
  lower (~5–10%) or an absolute floor — else collapse to the single lower/midpoint.
  Automatic, no toggle; keep line-level ranges always-on. Candidate home: a helper
  next to `format-range.ts` that the headline/list/compare call sites consult.
  Decision deferred — live with always-on first and see if it's actually noisy.

### Recipe & cookbook UX (2026-07 audit)

- [ ] **Cookbook lifecycle**: no rename/metadata edit (a mangled OPF title is
  permanent); identity is keyed on `name` (same-title books collide, a re-titled
  EPUB forks a duplicate — needs merge/re-point); `subjects` renders only as a
  truncated first-two stat in the cookbook hover-preview card
  (`EntityPreviewContent.tsx`) — still no browsable/filterable facet on the
  cookbook list; list has no search/sort/filter (incl. a "partially imported"
  filter from `sourceRecipeCount - recipeCount`).
- [ ] **Export "Read" format**: the print/export sheet offers prep/nested/matrix/
  flow (all spec- or diagram-flavored, the last an AI-assembled step flow chart)
  but no plain recipe-as-a-page format (`RecipeMagazineView` would drop in); no
  multi-recipe/cookbook export.
- [ ] **EPUB recipe hero photos**: `recipe-epub` already identifies an in-archive
  hero `ImageRef` (`path` + `mime`), but recipebridge emits `None` and
  `importRecipeSchema` models only public scraper image URLs. Emit the reference,
  materialize the referenced EPUB bytes into R2 during the watched import, and
  attach the resulting image to the recipe. Keep this synchronous with the rest
  of cookbook import; it does not justify a queue under tenet 3.

### Rejected

- **Recipe QR labels.** `sheet-layouts.ts`'s `LabelItem.entityType` is
  documented as "Locations and products only, deliberately" — a QR label is a
  physical sticker that belongs on a bin or a thing you own, not on a recipe.
  Widening `entityType`, adding `recipe.getByShortcodes`, or putting
  `PrintLabelButton` on the recipe detail page would all fight that comment.
  The recipe detail page instead shows its shortcode copyable via the
  standard `heroNo` breadcrumb (matching product/location) — the id is
  reachable without treating the recipe as a label target.

---

## Nutrition & cost intelligence (WASM conversion)

Price-per-nutrient, daily-value %, nutrient-density comparisons, batch ingredient
parsing (`parse_ingredient_lines`), and custom serving aliases all shipped. Remaining
follow-ups:

- [ ] **Collapse USDA duplicates by UPC — only if it resurfaces.** FDC mints a new
  `fdc_id` on every republish, so one barcode maps to several rows (UPC
  `857750003948` → `1433980` / `1726281` / `2160231`, the oldest with no nutrients
  at all). Two fixes shipped: lookup now takes the newest row, and
  `search_usda_foods` uses `relevance` ordering, which leads with UPC-less SR
  Legacy / Foundation foods — so the duplicates fell off page one on their own and
  no de-duplication was built. If they come back (a brand-name query, deep paging),
  the cheap fix is to reuse the existing `dedupeUsdaFoodsByUpc`
  (`lib/usda-food-stats.ts`, already used by the picker combobox and ingredient
  review card) inside the MCP tool handler. **Not** a SQL dedupe in usda-api: the
  list query's `count` and `data` come from different FROM clauses and are never
  reconciled, and that count drives the `/usda` table's pager.
- **Decided: `NutritionLabel` leads, `NutritionInfoTable` demoted to a disclosure.**
  The raw nutrient table stays — it's the only surface for non-tier-1 nutrients
  (B-vitamin variants, fatty-acid breakdowns, amino acids, sugars), and a straight
  swap to `NutritionLabel` would silently drop all of them. Resolved by leading
  with `NutritionLabel` and collapsing `NutritionInfoTable` behind a "Full
  nutrient breakdown" disclosure (`FullNutrientBreakdown`), applied uniformly on
  USDA food, ingredient, and product detail — closing the 2026-07 audit's "third
  raw-table instance" note on ingredient detail.
- [ ] **`parse_scraped_recipe` could return parsed lines**: today it returns raw
  ingredient strings and the import path batch-parses them separately; folding the
  parse into the scrape export would save one boundary crossing on import.

### Rejected

- **DV% as graph edges** ("90 mg vitamin_c = 100 %dv" per product graph) — a DV is a
  regulatory constant, not a property of a food; no conversion routes *through* a DV
  node, so edges would bloat every costing call for nothing. DV% is a display-time
  scalar against `DAILY_VALUES` in `@cubby/usda-schemas` (same class as
  `perServingRange`).

- **Inventory depletion preview** ("if I make this recipe, how much of each nutrient
  will I have left?") — needs a precise running stock balance, which
  [tenet 1](../README.md#tenets) says inventory will never be. Cost/nutrition per
  *recipe* is the useful half and already exists.

### USDA

- [ ] **Decide whether edge FTS should include brand fields**: the current D1/R2
  artifact indexes only `description`; the retired SQLite runtime also indexed
  `short_description`, `brand_name`, and `brand_owner`. Before the next full USDA
  rebuild, decide whether food-name-focused search is intentional or add those
  fields to restore brand-search parity.

---

## Mobile / PWA

App-shell service worker, critical-bundle trimming, route skeletons, iOS
camera-permission recovery, and the bundled ZXing scanner (`barcode-detector`, no
runtime CDN) are all shipped. Target is iOS Safari only. Remaining:

- [ ] **C3 — residual N+1 audit**: sweep products/recipes/inventory-detail for per-row
  query fans and batch them the way `getByLocationIds` did. Network panel should show a
  constant query count regardless of row count. Timeboxed; only promote a concrete
  fan-out found in a fresh network trace. The former flagship instance is closed:
  `location-gallery.tsx` has derived its inventory projection from
  `location.makeTree` since #639 and no longer calls `useAllInventoryItems()`.
- [ ] **Sentry lazy-init (optional)**: init in `router.tsx` is already client-only with
  dev tracing/replay disabled and replay prod-only; if ever picked up, run a temporary
  `rollup-plugin-visualizer` treemap first to confirm it's still the biggest
  critical-path item.

---

## Inventory & recount (2026-07 audit residue)

- [ ] **Backfill the 98 products with unquantified expense lines**: they render
  as `N +M?` in the products table's Expected column, and 125 of the 218
  shelf-vs-ledger mismatches are stocked products with no product-linked
  Expense at all (a provenance gap, not a counting one). The variance filter
  already excludes that second group; the first is ordinary data entry through
  Expenses → Missing quantities, where the quantity field is editable in place.
- [ ] **Problems detectors for cookbooks**: partially-imported cookbooks
  (`sourceRecipeCount > recipeCount` — visible only if you open that book).
  The meal/recipe ones shipped: `emptyCookedMeals`, `understatedCostMeals`
  (`costCovered < ingredientCount`, deliberately not `totals IS NULL` — that
  self-clears and `staleRecipeTotals` already owns it), and
  `recipesWithoutInstructions` (Book/Notion sources excluded).
- [ ] **AiSearchBar on inventory is thinner than the plain filters**: it can
  only set `productName`/`locationName` — the two substring filters already on
  screen. Either teach it quantity/category/valuation/verified-before/subtree
  filters or drop it from that surface.
- [ ] **Placement pass — "where does this live?" for the unlocated backlog**:
  the `unlocated` view converges by marking `stockTracked` false or true, but
  the ledger shows 1,635 products marked false and **zero** marked true — "yes,
  I keep shelf records for this" is unreachable in practice, because nothing
  lets you say *where* in the same breath. Add a session-shaped pass over that
  worklist: one product at a time, with three answers — not tracked
  (`stockTracked: false`, today's only option), here (pick a location, create
  the entry, set `stockTracked: true`), or skip. Reuse the pieces that exist:
  `MoveToDialog`'s tree picker, the immediate-write pattern from the Unknown
  tray's pull-from-Unknown, and the view's own price-desc sort so money
  surfaces first. Scale: 2,764 undecided-and-unlocated products, but only 626
  durables and 25 worth $50+ — so cap the pass by value or category rather than
  offering a 2,764-item queue. This is the mirror of the Unknown tray: that
  drains items filed in the wrong place, this files items that were never
  placed at all.
- [ ] **The identity-product image fallback stops at the tree-fed surfaces.**
  `locationCoverImage` (PR #767) resolves a location's own photo, else the cover
  of the SKU it IS, and the hovercard, the ⌘K search hit, and the locations list
  column all go through it. The gallery, the card grid, and the arrange thumbs do
  **not** — and adding the call there would be a silent no-op, which is the part
  worth remembering. Those three read `location.makeTree`, whose rows are typed
  `InfLocation` but come from a raw recursive CTE that never joins the identity
  product, so `buildLocationWithChildren` maps `product` to `null` for **every**
  node. The type says the data is there and it never is. `ArrangeThumb` also
  takes a bare `images` prop, so it needs `product` threaded before it could ask.
  The fix is a join in `buildLocationTree` plus its cover, which adds per-node
  work to the query behind `/locations/arrange` — a route that is `ssr: false`
  precisely because it dehydrates 844 KB (see [apps/web/CLAUDE.md](../apps/web/CLAUDE.md)).
  **Trigger**: enough product-linked bins without their own photo to make the
  placeholder tiles annoying in the gallery — 14 at the time of writing, against
  160 locations that have a photo of their own and are unaffected. Cheaper
  alternative if it stays small: photograph those bins instead of widening the
  query.

- [ ] **Seed a recount pass from the shelf-vs-ledger variance worklist**: the
  review pane now shows a ledger mismatch inline; the remaining slice is a pass
  root that is a product set rather than a location subtree, so a walk visits
  the disagreeing products wherever they live. Scale check: 606 entries are
  unverified but only 22 products actually disagree, so an untargeted sweep
  spends most of its time confirming what two independent sources already agree
  on. Slice (2) needs a session root that is a product set rather than a
  location — the bigger half; slice (1) is display-only.

---

## Meal planning v2

v1 shipped — calendar (week + table), per-meal scaling, and a display-only shopping
list (need vs. on-hand). The shopping list stays **display-only**: it reads inventory,
it never writes it. Deferred:

- [ ] Recurring meals, meal templates, nutrition goals (each its own future
  slice). Meal labels shipped as the `mealType` (slot) + `mealKind` (cooked /
  leftovers / eating out / takeout) enum pair.
- [ ] **Shopping list v1.6** — what's left of the v1.5 bullet, and note the
  original "all display-layer" claim was wrong: two of these **write**, and the
  units item needed Rust. Shipped: estimated trip cost, shopper-friendly units
  (`format_amount_shopper`), excluded-meal toggles in the URL, copy-as-text +
  print, and the check-off key no longer keyed by date range. Remaining:
  manual/ad-hoc items ("milk, paper towels" — a new table, and the first write
  on this surface); pack rounding (needs pack size off the product's purchase
  mapping); cross-device check-off (server-persisted, also a write).
- [ ] **Calendar ergonomics**: duplicate a meal / copy last week without a
  detail-page round-trip. The rest of this bullet is done or stale — drag-to-
  reschedule shipped, "+ Meal" opens in place, the week grid and its
  `min-h-32` cards are gone (the month grid is `min-h-24 sm:min-h-28`), and the
  phone agenda shipped as `calendar-agenda.tsx` (app-side: reui advertises an
  agenda view but only the month view was ever vendored).
- [ ] **Suggestions page follow-ups**: make cards actionable (link missing
  ingredients to their fix surface, "add the missing 2 to the shopping list");
  reachable from inventory, not just the nav dropdown (home already links to it).

### Rejected

Both die on [tenet 1](../README.md#tenets) — inventory is a ballpark refreshed by a
deliberate recount, never a running balance:

- **Phase 4 — cook / consume inventory.** `meal.markCooked` deducting each scaled
  ingredient across entries in a transaction. Deducting from counts that are already
  approximate and possibly months stale makes them *less* true, not more, and it puts
  a silent write behind a one-tap action. Consumption stays an explicit human edit.
- **Expiration-aware suggestions + FEFO consumption.** Nothing captures an expiry
  date today — there is no such column on `InventoryEntry` — and FEFO is meaningless
  without both per-lot dates and trustworthy counts. Would require inverting tenet 1
  first.

---

## Household tracker / ERP

The tracker module (projects / tasks / expenses) is feature-complete standalone —
including actionable-task reads, one-level checklist subtasks, and arbitrary-depth
sub-projects (a sub-project's `costEstimate` is the budget envelope for a
trade/phase, with subtree rollups on parents). The open work below connects it to
the rest of cubby. Schema affordances already in place for it: `task.projectId` is
nullable (inbox tasks) and `expense.future` marks planned-not-yet-actual spend.
The triage board, not this catalog order, sets priority.

- [ ] **Recurring maintenance tasks**: simple every-N-weeks/months interval on a
  template — not RRULE; next instance generated on completion; surfaces in
  needs-attention. (The rest of the old maintenance+budgeting bundle shipped
  2026-07: inbox view + promote-to-project, the attention detectors in
  `repo/project/attention.ts`, and the planned-vs-actual budget views.)
- [ ] **Location subtree filter scoping** (deferred from the 2026-07-30 MCP-gap
  pass). `parentId` matches direct children only. Add a scoped descendant-id helper
  modelled on `repo/project/subtree.ts` (depth cap + `visited` guard), make
  `locationList`'s where-build async, then add `includeSubLocations` to location
  and inventory filters. Do not reuse `repo/location/tree.ts`'s whole-tree,
  relation-heavy CTE. Deferred because its cost exceeded its observed use.
- [ ] **`projectMaterial` BOM**: on top of the bridge — quantity + free-text unit,
  optional product resolution, durable-vs-consumable flag → **have / need / buy**
  per project via the availability engine, shopping list from shortfalls. No
  reservations, no auto-decrement — audits are the backstop, "mark consumed" is an
  optional explicit action.

### Rejected

- **`task.completedAt` column** (2026-07 audit item, tracker data gaps). Proposed
  for velocity / "year in the house" reporting and to de-noise the
  stalled-project detector, whose `max(task.updatedAt)` dates every project to
  whenever it was last imported rather than when the work happened. Measured on
  production: 1,111 of 1,116 done tasks were Notion-imported in one window, so
  `updatedAt` spans only 2 distinct months (2026-07-18 → 2026-08-12) while
  `dueDate` spans 32 months (2023-10 → 2026-08) — zero rows have `dueDate` equal
  to `updatedAt`'s day, and 1,110 are off by 30+ days. A `completedAt` column
  would duplicate what `dueDate` already records, and backfilling it from
  `updatedAt` (the only data available) would collapse that 3-year history into
  the 3-week import window — worse than not having the column. The
  stalled-project detector now derives activity from `dueDate`/`expense.date`
  directly (`repo/project/attention.ts`) instead.

### Expenses ↔ inventory bridge (staged; v1 SHIPPED 2026-07)

Ground truth that shaped the staging: tools **already are** products (74 `tools`
products, 68 inventoried, 79/94 tool-ish products priced — the garage valuation
rollup works today), and coarse multi-trade runs are **already split by hand** —
201 of 369 dated days carry more than one ledger row, 151 span more than one
trade. Only 33 of 268 `tools` rows fuzzy-match an existing product name, so a
product link is sparse and stays opt-in. Hence v1 is two nullable columns and zero
new tables; everything below it is additive, behind an explicit trigger.

**v1 (shipped)** — `expense.productId` + vendor capture. Link a ledger row to a
product (opt-in; services/materials stay unlinked), explicit
**receive-into-inventory** from a linked row (never automatic — the mirror of
the no-auto-decrement tenet), buying history + derived net cost on the product
page, vendor on the ledger. Linked rows double as price observations —
read-only history first; promoting into `product.price` stays a later explicit step.

**The lifecycle convention is the load-bearing part and costs zero schema**: every
exit is a *terminal negative expense carrying the same productId* — sale at sale
price, return at full price, broken/gifted as a **$0 expense** (never null: `cost
IS NULL` is the Unclassified predicate) — plus an explicit inventory decrement.
Money is derived as `splitExpenseSpend(rows).actual - .contributions` (NOT `.net`,
which folds in `future` rows); **owned/sold comes off `inventoryEntry`, never off
expense signs** (two buys + one sale nets positive — the sign is ambiguous). No
status column, no disposition enum, no `Sold` location.

**Ledger surfacing shipped** (PR #421): Product column on `/expenses`, a
linked/not-linked presence filter, and `?productId=` deep-linking from the product
page. "Linked" means `productId IS NOT NULL` — deliberately including rows whose
product was later soft-deleted (they read back with `productId` set and
`productName` null). Presence is Tier A (`isNull` on a real column), so the
RQB correlated-EXISTS trap doesn't apply here.

**Backfill: 26 of 897 ledger rows linked; ~242 `tools` rows stay unlinked and
that's correct.** How it was done, since the method generalizes: embedding
nearest-neighbour (`find_similar_entities`, `expense_to_product`, PR #422)
**deduped to mutual-best pairs** — without that dedup one generic "m18 angle
grinder" row was the top candidate for six different M18 products, and a row can
only carry one `productId`. Ranking alone is not enough: a wrong `M18 Hackzall`
match outscored a correct `TS 55 Track Saw` one, so every pair was confirmed by
hand. The signals that actually disambiguated were **`expense.url`** (a Home Depot
link literally naming "14-Gallon" settled which shopvac; a boschtools SDS-plus link
settled the rotary hammer) and **`stockCount`** (the 12 gal shopvac had zero on
hand). Price agreement helps above ~$50 and is noise below it — a $10 tarp
"matched" a $10.83 trowel.

**Bucket products do NOT get product links** (decided 2026-07). `assorted clamps`
($5), `misc: kitchen project stuff`, `misc: plumbing, elec, small tools` and friends
are an inventory convenience, not things with a cost basis or a lifecycle. Linking
a $171 clamp run to a $5 bucket would make "net cost" mean two different things
depending on the product. Those rows stay unlinked — the designed default.

**The `Receipt` phase SHIPPED as `Vendor ──< Purchase ──< Expense`** — the purchase got
its own table rather than a receipt hanging off the ledger row, so `Vendor` is a real
roster and `Purchase` holds the order id, purchase date, `statedTotal`, notes, and its
documents (`PurchaseImage`, `attach_file` with `entityType: "purchase"`). The emailed
PDF invoice finally has a home, and reconciling one purchase against N rows is a
single-row comparison (`statedTotal` vs `SUM(expense.cost)`, surfaced as the
`purchasesNotReconciling` Problems detector) instead of a reconstructed
`GROUP BY (vendor, orderId)`.
Also landed: `linkExpensesToPurchase`, `splitExpense`, `mergePurchases`, and the
deletion of two now-unrepresentable Problems detectors
(`findOrdersWithPartialVendor`, `findVendorSpellingVariants`). No `splitPurchase` and
no `Payment` axis — see `packages/schemas/src/purchase.ts` for why.

Follow-ups the split itself generated (small, none blocking):

- **`findDuplicateVendors` will not catch abbreviation drift — closed, not deferred.**
  `B&H` vs `B&H Photo` normalize to different keys (`bh` / `bhphoto`) and go
  unreported; that real pair was found by eye while filling in websites. Two
  candidate signals were considered and **both are dead**, so don't reopen this
  without a third idea:
  - *Trigram similarity on `Vendor.name`* — already measured on the live ledger and
    recorded in the detector's own header comment
    ([detectors-label-variants.ts](../apps/web/src/server/repo/problems/detectors-label-variants.ts)):
    at `> 0.3` it flags 13 pairs, **all false positives** (`Ace Hardware`/`DK Hardware`,
    `Home Depot`/`Office Depot`, `Tool Nirvana`/`Tool Nut`), and the real drift
    (`Amazon.com`, 0.636) does not separate from the noise (`Festool`/`Festool Recon`,
    0.571). Brand names share industry nouns, so the score measures the shared noun.
  - *Prefix containment on the canonical key* — the tighter signal, and it fails for a
    structural reason rather than a tuning one: it flags `festool ⊂ festoolrecon`
    exactly as it flags `bh ⊂ bhphoto`, and those are **two different vendors** (a brand
    and its outlet store). `X` vs `X <qualifier>` is lexically identical whether it's a
    duplicate or a separate business, so no threshold separates them.

  The roster is 113 rows and human-scale; merging a duplicate found by eye is a UI
  operation. Accept the gap.
- [ ] **Near-white vendor logos need a RENDER fix, not a seeder filter.** A
  white-on-transparent favicon renders as a blank tile against warm paper once
  `grayscale(1)` applies at rest. Measured 2026-07-30 (mean channel value of the 32px
  transformed variant, alpha composited onto white via `magick -alpha remove
  -background white -format '%[fx:mean]'` — note plain `urllib` is UA-blocked by
  Cloudflare, and `-alpha remove` is not interchangeable with `-flatten`: `veradek`
  reads .9876 vs .9907): `veradek` .988, `the-growers-exchange` .965, `walmart` .923,
  `visual-comfort` .911, `jacquemus` .895, `ebay` .892, `supplyhouse` .879,
  `ace-hardware` .870, `sherwin-williams` .864, `rubio-monocoat` .859.

  **A seeder-side rejection gate was built and then removed — don't rebuild it.** At
  `NEAR_WHITE_MAX = 0.9` it demoted **10 real brands** to monograms, including
  `Masseria Calderisi`, the single largest vendor by spend ($142k). A faint real mark
  still carries more identity than an initial, and the gate also conflated two
  opposite operator signals: "this domain is dead, fix the field" and "this domain is
  fine, the brand's mark is just white" both surfaced as *check the domain*. The
  problem is that we render a light mark on a light ground — so fix it where it is:
  give the mark a neutral chip/plate behind it in `vendor-cell.tsx`, or skip
  `grayscale(1)` at rest below a luminance threshold **computed at render time**. That
  keeps every logo stored and lets the display adapt, instead of deciding at seed time
  that a brand has no logo at all.

- **`Vendor.kind` stays removed** — nothing branched on it and it was
  null on 111 of 114 rows. Contractor metadata (license number, COI expiry) would
  bring it back as additive columns plus a discriminator; don't re-add it decoratively.

Deferred phases — each purely additive on top of v1, with its promotion trigger:

- [ ] **`PurchaseLine`** (`purchaseId`, `name`, `sku?`, `quantity?`, `unitPrice?`,
  `expenseId?` soft-link) — was `ReceiptLine`. Optional **SKU-level** itemization,
  **pure annotation**: rollups only ever read `Expense`, lines need no product, and a
  sum mismatch is a soft display-level flag, never enforced. Note `Expense` already
  covers *categorized* splitting of a purchase (that's what `splitExpense` is for), so
  the only thing left here is store SKUs/quantities. **Trigger**: actually wanting
  them.
- [ ] **`ExpenseProduct`** join + `quantity`, replacing `expense.productId` (was
  `PurchaseProduct`, renamed since `Purchase` now means the purchase). **Trigger**: one
  ledger row genuinely needing 2+ products (combo kit) that `splitExpense` can't
  reasonably split, or a correct unit-price observation on a multi-quantity buy.
  Mechanical migration: insert-select from the non-null column, drop it, update read
  sites.
#### "A product for every line item?" — asked and answered 2026-07-31

**Measured before deciding** (live ledger): 1141 expenses, **1081 distinct names** — 92%
of names occur exactly once. Only 10 names appear 3+ times, and they are subscriptions
(`chief architect monthly` 9×, `cutlist optimizer` 5×, `autocad lt` 4×), services
(`hauling`, `delivery charge`) and fungible categories (`plywood`, `gloves`, `plants`,
`pvc fittings`). Of 432 products, 155 carry an expense and 44 carry more than one — but
**38 of those 44 are the negative-expense exit pattern**, leaving **6 products genuinely
bought twice**. So universal productization buys ~6 products of repeat-purchase signal
for ~940 new rows. **Rejected as a blanket rule**; the sparse opt-in default stands, and
`expense.productId`'s own schema comment already says so.

What did change is *why* a line stays unlinked. Four of the classes originally listed as
"not products" are really **un-split imports** — bundles (`wall materials, strut stuff`),
aggregate credits (`lowes returns` −$77.46) — and those should be unbundled per the
existing `splitExpense` path, each part taking its own product. That is not a new feature;
it is Phase 3 of the purchase-import skill, now stated explicitly there. Two classes are
genuinely never products: **service/labor lines** (no object, and `Expense.productId` is an
`acquisition` edge whose net-cost derivation a labor line would inflate — work *about* a
product is `Task.subjectProductId`) and **allocations** — see below.

##### `Expense.lineBasis` — allocations are never products (2026-08-05)

The "deposit/balance pairs" listed above as un-split imports were **wrong**, and
`splitExpense` cannot fix them. Both are now `lineBasis: "allocation"`, a first-class
column, and both are excluded from the goods-without-a-product saved views.

Two ways a lump sum becomes ledger rows without ever being itemized:

- **By payment schedule.** Ferguson order 5099637 is six appliances paid as a $13,000
  deposit and a $12,734.51 balance. The deposit is money on account; it buys no
  particular appliance, so there is no split that assigns it to items. Splitting by
  *item* instead would destroy the two ledger dates, which the purchase merge
  deliberately preserved.
- **By an estimated materials/labor split.** `retaining wall 1/2` is `materials` and
  `2/2` is `services`, $8,000 each, on one non-itemized $16,000 contract — the
  installment boundary standing in for a guess at the trade split. Same for the
  countertop pair, the Maldonado fence (whose proposal is explicitly "furnish material
  **and** labor... for the sum of", with materials listed but unpriced), and SL Electric.

  ⚠️ **This is a deliberate convention, not drift.** The `servicesWithProduct` note below
  cites `countertop deposit` (materials) vs `2nd half of countertop` (services) as
  evidence that `costType` is "already inconsistent". It is not — it is this estimate,
  and reclassifying those rows to match each other would destroy real information.
  `lineBasis: "allocation"` is now the signal that a row's `costType` is an estimate
  rather than a vendor-stated fact.

**Never inferred from the name** — `"1/2"` matches `1/2 in. conduit` far more often than
an installment half. Set it by hand; the `purchase-import` skill checklist covers it.

Why on `Expense` and not `Purchase`: allocation siblings routinely span *separate*
Purchase rows (drywall 1/3, 2/3, 3/3 are three Purchases; so are the countertop deposit
and balance). A purchase-level flag would also have needed an explicit `isNull(purchaseId)`
arm in the expense filter, since `IN (SELECT ...)` goes NULL on a NULL left side — ~193
live rows silently dropped.

Backfilled 18 rows across 9 contracts on 2026-08-05, which took the
"Goods without a product" view from 293 to 282. Small by count (3.8%) but it was the
entire *top* of that cost-sorted list, because lump-sum structure correlates with size —
the largest purchases are the ones paid in installments.

⚠️ **That first backfill was incomplete, and the way it was wrong is worth remembering.**
Its population was built from the goods view itself (`costType IN (materials, tools)`), so
a **services-only** installment series was structurally invisible to it — the search only
ever looked at the list it was trying to shorten. It therefore missed the single largest
series in the ledger: Masseria Calderisi's **11 staged payments, $142,769**, each on its
own Purchase. A second pass on 2026-08-06 added 23 more rows (that series plus a wedding
planner's 4, and installment pairs from Avidon, De Le Floor, The Dog Tree Service and A1
Hauling), taking allocations to **41 rows / $248,985.46**. Deliberately excluded there:
A1 Hauling's `hauling #1/#2/#3`, where the number is a job counter rather than a payment
number, and a standalone `palm tree removal`.

One of those, Avidon's `raised beds 1/2` + `2/2`, was in the goods view all along and
still slipped through — and it turned out to carry the very bug the column exists to
prevent: both installments pointed at the SAME product with a null `productQuantity`, so
both costs were silently dropped from that product's price numerator. Its provenance now
lives on the `PurchaseProduct` link instead.

- [ ] **Surface the estimate caveat in spend breakdowns.** `allocation` makes "this
  `costType` is a guess" *representable* for the first time, but nothing reads it yet:
  `expenseAnalytics`' `byCostType` still mixes allocations in with vendor-stated lines,
  and a human reading those totals gets no hint. As of the 2026-08-06 backfill that is
  **$248,985.46 across 41 rows** — $58,970.77 booked materials, $190,014.69 services — and
  for the lump-sum-contract subset those two numbers are a guess at where the split fell,
  not something a vendor ever stated. The MCP
  tool description warns an agent; the UI warns nobody. Cheapest honest version is a
  footnote on the analytics tab ("includes $X across N estimated splits") rather than
  excluding them — they are real spend and excluding them would understate the total.
  **Trigger**: actually using a materials-vs-labor breakdown to decide something.
  (Raised in review on #649.)

- [ ] **`servicesWithProduct` advisory detector** — mirrors `purchasesNotReconciling` in shape
  (soft worklist, not an error list). The 2026-07 audit found **zero** live rows, so any row
  appearing is a real regression rather than a backlog. **Trigger**: the first observed
  row, or repeated import behavior that can create one. Deliberately **not** a CHECK
  constraint: `costType` is an operator-assigned *reporting* dimension that is sometimes an
  **estimate** rather than a fact (`countertop deposit` is materials, `2nd half of
  countertop` is services — same vendor, same amount, same slab, because the installment
  boundary is standing in for a guess at the trade split; those rows now carry
  `lineBasis: "allocation"`, and reclassifying them to match each other would destroy real
  information), and `update_expenses` batches can reclassify rows, so a hard
  constraint would fail a bulk reclassify mid-transaction with an error about products.
- [ ] **Repeat-purchase rollup** — `ProductExpenseHistory` already ships per-product on the
  detail page and the Products list exposes a linked-expense count. What's missing is
  ranking that cross-product view by purchase count or total (the current Expenses column
  intentionally cannot sort). **Trigger**: enough productized repeat buys to be worth
  ranking — 6 at the 2026-07 audit, so not yet.

- [ ] **`returnedUnitInflatesPrice` advisory detector** — the derived-price aggregate filters
  to `cost > 0`, so a **returned** unit contributes both its cost and its unit while the
  offsetting refund is filtered out. The per-unit price then blends in a unit that was sent
  back. Found on a 90-piece bit set whose returned combo pulled its basis from $19.99 to
  $26.65, a $6.66/unit overstatement on everything stocked; fixed there with an override.

  **The blocker is that `Expense` cannot tell a return from a sale.** Both are a negative
  cost with a negative quantity. For a **sale** the acquisition cost *should* stay in the
  basis — you owned the thing — and only a **return** should drop out. 435 live products
  carry negative-quantity rows and ~$28k of basis sits on them, but 333 are fully returned
  (no inventory, so the skewed price multiplies against nothing) and a survey of the
  stocked remainder found the rest within pennies. So this is one real row, not a class.

  **Ship it as a detector, not as a pricing change.** A detector changes no money, can use
  a heuristic ("negative row against the same vendor and order as the acquisition") without
  that heuristic having to be right every time, and turns a wrong guess into a false
  positive on a worklist rather than a wrong valuation in the location rollup. It also
  converges: each row is either overridden or dismissed. Same reasoning as
  `servicesWithProduct` above, which is deliberately advisory because its dimension is
  sometimes an estimate. **Trigger**: a second stocked product whose derived price is
  materially wrong from a return, or any structural signal that separates the two.
  Promote the aggregate change itself only if the detector fills up.

**`PurchaseLine`'s trigger is still NOT met by this** (see the deferred phase above). Unbundling
that *moves money* is `splitExpense`, which exists and is money-bearing; `PurchaseLine` is
pure SKU/quantity annotation and creates no products. Don't reach for it to do this job.

Re-examined 2026-08-05 while adding `lineBasis` and judged **still not met** on volume —
one Ferguson is not a table. That reasoning was right about volume and **wrong about
kind**, and `PurchaseProduct` shipped 2026-08-06 as the answer instead.

The correction: this is not a Ferguson quirk. *Any* purchase paid in two or more parts
leaves its goods orphaned, because `allocation` makes the expense link permanently
unavailable — and the correlation runs the wrong way, since the orders most likely to be
split into installments are big-ticket durable goods (appliances, furniture, custom
fabrication), which are exactly the things most worth holding as Products. Cheap items
are paid in one go and productize fine; expensive ones get split and vanish. The backlog
looked small only because one such order had been productized.

**`PurchaseLine` remains unbuilt and its trigger unmet.** `PurchaseProduct` is the bare
pair — no `name`, no `sku`, no `unitPrice`, and deliberately **no `quantity`**:
`Expense.productQuantity` already owns "how many units did this money buy", and a second
copy would answer the same question from a second table with no rule for which wins.
Reach for `PurchaseLine` only when a line's own SKU/unit price is genuinely needed;
`splitExpense` still itemizes wherever the money actually decomposes.

`ExpenseProduct` is also the wrong shape for this — it is the transpose (one row needing
many products, not many rows for one purchase's goods), and it would still force an
arbitrary allocation of the deposit across the order's items.

### Purchase-import — maybe later (trigger-gated)

These are not work implied by a completed historical backfill. Future imports are
expected to be small and interactive; promote one only on the stated evidence.

- [ ] **`PurchaseEvidenceReference`** — structured Gmail, Drive, or vendor-portal
  evidence pointers. **Trigger**: repeated need to query those references beyond
  Purchase notes and attached documents. It must not turn pasted email text into a
  fabricated primary attachment.
- [ ] **Durable import checkpoints/orchestration**. **Trigger**: a future import
  genuinely spans sessions and cannot resume from client-held source keys and normal
  MCP queries. Do not build queues, retries, or vendor parsers for ordinary small
  interactive imports.
- [ ] **`PurchaseRelation`** for replacements/exchanges. **Trigger**: those links
  need navigation or querying rather than truthful Purchase notes.

Still rejected: permanent Amazon/Home Depot parsers, universal Product creation,
additional Purchase money totals, and money-bearing adjustment tables. `PurchaseLine`
already has its own trigger above and is intentionally not duplicated here.

Two traps this design already walked into once — don't re-introduce them:
`buildSearchConditions` **ANDs** its `searchFilters`, so vendor must never share the
`search` term (it would mean `name ILIKE q AND vendor matches q`, and most rows have
no vendor → search silently returns nothing). That's why `expenseFilterFields` keeps
`vendorId` as its own filter even now that it's an id rather than free text. And
`InventoryEntry` has a partial unique index on `(productId, locationId)`, so the
receive flow **must** branch (create / top-up existing / move a unique item) rather
than blind-inserting.

Rejected within this design: **`Asset` entity** (a fixed-asset register would duplicate
the live inventory layer for location/valuation/audits and guarantee sync drift; pooled
cost basis on identical tools is consciously accepted; it layers on later without
unwinding v1); **`Sold` virtual location** (pollutes valuation and audits — "former
tools" is a query, not a place); **disposition status enum** (the $0-exit convention
makes it derivable); **line items as financial truth** — still rejected, and *not* what
the `Vendor ──< Purchase ──< Expense` split did. The rejected shape puts a **new
money-bearing level below** the ledger row, so a row's cost becomes a sum over its
children and every row needs itemizing to be trusted — unwarranted when 95% of purchases
are single-trade. What shipped adds a header **above** the row that carries **no
money**: the ledger row (now `Expense`) is still the money, untouched, and `Purchase`
holds identity plus a `statedTotal` that is **never summed into spend**. Spend is
`SUM(expense.cost)`, full stop. A proposal that derives spend from a header total, adds
header and line totals together, or makes a line's cost a rollup of sub-lines is the
rejected design.

### Longer-term (synthesis out, capture in)

The data model is nearly complete; the long-run constraints are **capture friction
in** (getting reality into the DB cheaply) and **synthesis out** (turning the record
into decisions). Single-user tool — optimize for one household's taste.

- [ ] **House timeline / "Year in the House"**: unified chronological views over the
  already-timestamped record — scrollable house journal, before/after photo sliders,
  annual wrapped-style report. Pure synthesis, zero new data entry.
- [ ] **Household balance sheet**: generalize location valuation — capex forecast
  from asset ages + expected lifespans ("roof and water heater both die in ~5 yrs:
  ≈$14k"), cost-per-project analytics, insurance-claim / cost-basis exports. The
  costing engine pointed at the house.
- [ ] **Ambient capture**: every low-effort input path — voice memos from the shop,
  an email-forwarding address that files what's sent to it, photo share-sheet, NFC
  tags on machines (tap → service log). Flagship: voice via Home Assistant Assist
  satellites routed to the MCP tools.
- [ ] **Standing agents**: a *registrar* (watches Gmail for warranties / receipts /
  orders, files against products & projects, approve-then-file), a *quartermaster*
  (consumable inventory → drafted shopping list), a *foreman* (stale projects raised
  in the brief).
- [ ] **Digital twin / spatial memory**: knowledge attached to the location tree as
  a building model — shutoff valves, breaker maps, paint-per-room. ⏰ **Hard,
  unrepeatable deadline: before-drywall photos during the extension build** (wire
  runs, pipe routes, blocking, pinned to the wall/room they live inside) — the only
  item that cannot be captured later. Seedable from HA's area/device registry.
- [ ] **Grow-to-table loop**: garden beds as locations, plantings as dated records,
  **harvests become pantry inventory**, availability engine pointed at the yard
  ("what can I cook from the garden this week").
- [ ] **Heirloom outputs**: house manual for a future owner, printed project
  yearbook, documented archive/export format — cubby's own graceful exit hatch.

### Home Assistant integration (cross-cutting)

HA is the *senses and voice*; cubby is the *memory and ledger*.

- [ ] **HA → cubby**: runtime-based maintenance intervals (smart-plug / HVAC hours —
  the automated version of hour-meters; manual tracking was rejected), measured
  project ROI (before/after energy curves on the project detail page), sensor faults
  (leak, sump over-cycling, freezer excursion) → tasks/Problems filed against the
  right asset, weather stamping for daily logs + outdoor scheduling.
- [ ] **Cubby → HA**: shopping-list bridge (cubby *computes* the list — food + BOM
  shortfalls; HA todo lists display/speak it), glance dashboard (maintenance due,
  weekend actionable tasks, tonight's meal).
- Plumbing: agent-mediated works today (scheduled agents beside the HA MCP); add a
  direct authed CF Worker webhook only for real-time sensor-grade events.

### Rejected (recorded so they don't resurface)

- **Ranged estimate expenses** (`costLow`/`costHigh` + a one-click settle) — modeled
  an estimate as a proto-expense, but in practice an estimate ("electrical is
  10–15k") is an *envelope* that dozens of real expenses accrue against; nothing
  settles 1:1. The envelope home is a **sub-project** with the existing single-point
  `costEstimate`; actuals attribute via `projectId`. No ranges anywhere, for now.
- **Monarch / finance sync** — the expense ledger stays hand-curated.
- **Receipt-export importers** (Amazon / Home Depot) — hostile, unmaintained
  formats; MCP conversational capture + a one-off throwaway script for backfill.
- **`project.locations` → Location FK** — free-text site names and the physical
  storage tree serve different purposes; revisit only if the BOM makes "materials
  for X are on shelf B" a real query.
- **Specs/sizes registry**, **offcut/scrap inventory** — anal-detail cliff.
- **Project templates / playbooks** — markdown notes at the right altitude beat a
  template system.
- **Manual hour-meter maintenance intervals** — only worth it automated via HA.
- **Cross-project material allocation** — the complexity cliff where Procore lives;
  at most an "also needed by project X" hint.
- **Tracker restore/undo** — soft delete stays permanent-from-the-user's-view, as
  everywhere else.

---

## Architecture / engineering

- [ ] **Expand server-backed table intelligence beyond Expenses.** The Expense
  analyzer is the proving ground: extend exact facet counts (and only then useful
  range summaries) to Products, Purchases, Tasks, Inventory, and Projects; add
  domain analyzers only where the server can return a complete aggregate with an
  honest reconciliation tail; add equal-length prior-period comparison only to
  analytics with explicit bounded dates; and opt other eligible desktop tables
  into typed numeric cell-selection statistics. A partially loaded or
  server-paginated page is never an analytical population and must not be grouped
  or counted as though it were complete.

- [x] **Converge every remaining drag surface on dnd-kit.** React Table layout
  now establishes the shared pointer, keyboard, and touch foundation. Migrate
  the Task Board and Location Arrange tree/board/dock first, then extract shared
  auto-scroll and evaluate the calendar and Gantt interactions against the same
  primitives. Each migration must retain virtualization, keyboard and touch
  parity, and existing invalid-drop behavior before its old implementation is
  removed. Delete all three Atlassian drag-and-drop packages when their final
  consumer is gone; do not carry parallel drag stacks indefinitely.

- [ ] **Finish the production query-cost sweep (#730 follow-ups).** A Neon
  `pg_stat_statements` dump prompted an audit against the live catalog. The
  index sweep (#733), the search-document batching, the orphan-embedding
  anti-join, the HNSW reindex (258MB → 213MB), the bound query vector, and
  `loadProductPricing`'s whole-catalog mode have shipped; three items remain,
  in rough order of value.
  - [ ] **Give the navbar badge a count-only procedure.** This is now the largest
    remaining cost on the page path, and it got worse with #731: the badge calls
    `useProblemsData`, which fires **all five** unbatched groups — `getFast`'s
    ~32 detectors *plus* every saved-view list query in `getViews` — on **every
    authenticated page**, to render one integer. There is no server-side cache,
    and a hard load starts a fresh QueryClient, so the whole set re-runs.
    - **Two approaches were rejected, so nobody re-derives them.** *Persisting
      the problems query keys* is out: `shouldDehydrateQuery` in
      `root-provider.tsx` deliberately excludes `.list` payloads because
      superjson-serializing them was profiled at ~38% of scroll-time CPU, and
      the five problems payloads are exactly that shape (arrays of rows across
      ~30 sections). *Dropping the route-loader prefetch* is out too — it was
      filed as a double-fetch and is not one: the page inherits the 60s default
      `staleTime`, so a dehydrated prefetch is a warm, not a duplicate. (Its
      comment IS stale, still describing the pre-#704 SSR self-fetch.)
    - **So the fix is a real `problems.getCounts`.** #731 already built half of
      it: `countViewProblem` and `executeListQueryWithCount` give exact counts
      for every view-backed section without materializing a page. The work is
      the `getFast` detectors, which return arrays and are summed by
      `countProblems` via `.length`. Several have no SQL `COUNT` today because
      they filter in JS after the query — `findOrphanedEntityEmbeddings` and
      `findPurchaseFinancialSettlementMismatches` are the clear ones.
    - **The trap to design against** is the one #731 spent real effort killing
      with `sectionTotals`: a count that drifts from the list it summarizes. A
      count-only path derived separately from each detector's predicate is two
      statements of the same question. Prefer deriving both from one predicate
      (the way the view-backed sections now do) over hand-writing a second
      `COUNT` per detector.
    - Cheap and independent of the above: run only the count arm of
      `findReferentialLivenessViolations` on the page path and fetch its sample
      rows lazily. It reports zero on production — an invariant audit, not a
      worklist — and costs 88 seq-scanning UNION arms per call.
  - [ ] **The purchase aggregates still bind ~3,139 parameters.**
    `loadProductPricing` got a `wholeCatalog` mode for the same problem
    (6.7ms unfiltered against 13.7ms with 5,553 binds); apply the same
    treatment to `loadPurchaseFinancialAggregates`, whose settlement caller
    likewise passes every live purchase. Note `eqAny` delegates to `inArray`
    and so does not help; a genuinely bound array needs the text-literal cast
    used by `getSearchDocumentSources`, and `hand-rolled-any-array` will
    (correctly) reject a raw `ANY(${...})`.
  - **Two counters worth an `EXPLAIN` before anyone "fixes" them.**
    `FinancialTransaction` shows **1,014,764 seq scans / 3.3B tuples** on a
    3,447-row table, and `Location` **655,591 updates** on 279 rows (the
    valuation rollup rewrites every row whenever `needsValuationRecompute` is
    true — any inventory mutation, any product update). Both are almost certainly
    real, but measure before restructuring: `db.ts` already records a case where
    a "slow DB write" turned out to be WASM CPU, because the workerd clock is
    frozen during synchronous CPU.
  - **Not doing (recorded so it doesn't resurface):** converting
    `EntityEmbedding.embedding` to a typed `vector(1536)` column so HNSW could
    index the column rather than the `::vector(1536)` expression. It would drop
    the per-insert cast, but the partial index exists precisely so integration
    tests can seed 3-dimension vectors. Bigger migration than the win justifies.

- [ ] **Measure and expand selective SSR only if the product-detail pilot wins.**
  Product detail now uses a request-scoped tRPC local link during SSR, preserving
  the incoming session, middleware, SuperJSON, formatted errors, and the existing
  TanStack Query key without a Cloudflare self-fetch. Its E2E proof covers initial
  HTML with JavaScript disabled, hydration without a duplicate detail request,
  authenticated not-found, signed-out redirect, and private no-cache headers. Run
  the planned cold-cache Chromium and mobile-WebKit comparison before migrating any
  other detail family; keep the remaining routes `ssr: false` unless the measured
  LCP threshold is met without an INP/CLS or Worker-error regression.
- [ ] **Selection-control consolidation — non-form phase.** Form and inline-edit
  pickers share the Base UI assignment-picker shell; remaining selectors are
  intentionally specialized. If visual or keyboard inconsistencies remain painful,
  migrate table/header filters, pagination, gallery and workflow-scope filters, plus
  the remaining native selects in activity, cookbook, and background-jobs surfaces.
  Treat the ReUI advanced-filter builder as a separate high-risk phase: its static/
  async, single/multi, selected-first, nested-menu, and max-selection paths should
  converge on Base UI behavior before deleting its manual keyboard handling.
  Command palette and action menus are different interaction types and remain separate.
- [ ] **Budget-aware cursor pagination for wide MCP tool results.** **Trigger**: a
  real tool result hits a host/output limit or is measurably too large for routine
  use; no such failure is recorded yet. MCP's native
  opaque-cursor pagination covers discovery operations such as `tools/list`, not
  arbitrary `tools/call` results, and `CallToolResult` carries no host context-window
  budget. Add tool-level `cursor` / `nextCursor` fields to the shared list plumbing,
  starting with `list_expenses`: use a stable keyset cursor so variable page sizes
  cannot skip or duplicate rows; treat `pageSize` as an upper bound while a
  configurable compact-JSON byte budget chooses the actual page; consume a future
  client budget hint if MCP standardizes one, otherwise keep the conservative
  server-owned byte budget. Invalid or filter/sort-incompatible cursors must fail
  explicitly rather than silently restarting from page one.
- [ ] **Duplicate `getByID`/`getByShortcode` read paths, no shared cache
  key.** All 15 shortcode entities (`shortcodeEntities`,
  `packages/schemas/src/entity-manifest.ts`) get two CRUD-factory procedures
  over the same row with the same input shape — `getByID` throws on a miss,
  `getByShortcode` returns `null` — as two separate react-query cache keys.
  `entity-contracts.ts`'s `detail` points every entity at `getByID`;
  repointing it at `getByShortcode` would silently swap a thrown-and-caught
  "Failed to load X" state (`entity-preview-panel.tsx`) for a
  quietly-successful `data: null` render, so all three preview consumers need
  an explicit null branch first. Meal detail no longer demonstrates a duplicate
  fetch: its loader and `meal-detail-page.tsx` both use `getByShortcode` with the
  same query key. Every other detail page (product, recipe, …) takes the entity
  as a prop instead of re-querying.
- [ ] **Two duplicate detectors have no fix action.** `problems/detectors-financial.ts`'s
  `findDuplicateFinancialTransactionSourceRefs` and
  `findDuplicateFinancialAccountSourceAliases` surface Problems-page findings
  with no merge or fix action attached, and neither `financialTransaction` nor
  `financialAccount` is in `previewMergeEntitySchema`
  (`packages/schemas/src/entity-integrity.ts`) — merge is money-entity
  territory and deliberately out of scope everywhere else in this codebase.
  Either add a lighter "drop the stale sourceRef/alias" fix action, or
  explicitly document why merge stays out of scope for these two.

### MCP Apps — further candidates

The SEP-1865 pipeline shipped with two apps (`get_shopping_list`,
`search_usda_foods`) — see [the README](../README.md#mcp-apps-interactive-uis-in-the-conversation).
Adding another is now three files: `apps/mcp-apps/<id>.html`,
`apps/mcp-apps/src/<id>.ts`, and an entry in `apps/mcp-apps/src/bundles.ts`
(the build discovers entry points, and the server maps the manifest) — plus
`uiResourceUri` on the tool.

The bar stays **chat is the right home AND text is a bad medium**. Candidates
that clear it, in rough order:

- [ ] **`explain_recipe_costing`** — a nested per-ingredient cost/calorie
  breakdown that reads terribly as prose. An expandable tree with the
  diagnostics inline is a genuine win. The most likely next one.
- [ ] **Merge confirmation** for `find_similar_entities` / `merge_ingredients` —
  a side-by-side of the two candidates with a single confirm. Deferred because
  the destructive path deserves more thought than a pretty diff: decide first
  whether the app should call `merge_ingredients` directly or hand the decision
  back to the agent the way the USDA picker does.
- [ ] **`resolve_ingredients` ambiguity** — same picker shape as USDA, but only
  worth building if the batch resolver's ambiguous-row rate stays annoying in
  practice.

**Rejected, don't re-litigate**: apps for `list_tasks` (kanban),
`get_expense_analytics` (charts), `list_problems` (triage), and the inventory
tables. The web app already does all four better, and `app.openLink()` back into
it is the correct zero-maintenance answer. An iframe is not the place to
reimplement `RTable`.

### Saved filters — user-created views

**Hardcoded views shipped.** `entities/view-manifest.ts` declares a view as filters +
sort; applying one sets column-filter state and the existing `useTableState` write-back
serializes it, so a view and a shared link are the same thing. The expense-ledger preset tabs
(`planned` / `unassigned` / `unclassified`) are gone, with a legacy `?view=` normalizer
for old bookmarks. `unclassified` stopped needing a special case once the Cost column
got a real presence filter. The `productId` deep link now has a `ScopeChip`.

What's left is **persistence**: letting the user name and save their own filter sets
rather than only picking from the hardcoded three. Storage should follow the stable
external-atom pattern now owned by `data-table/table-layout.ts`, with its own versioned
key rather than reviving the retired visibility/sizing stores. A saved view is the same
shape `view-manifest.ts` already uses, so `DataTableViews` should just render two groups.

The invariant is now explicit: a **renderer changes presentation** and a
**saved view selects records**. Projects History, Tasks History, and Tasks
Inbox are manifest declarations backed by visible URL filters; they are not
renderer arms. Renderer-intrinsic limits (Board's top-level layout/completed
cap, Timeline's dated-only rows, Next's actionable semantics) must be
server-enforced and disclosed.

### Remaining from the filter-honesty audit

The semantic cleanup shipped: dashboard-scoped attention, shared task/expense bulk
workflows, honest infinite-list URL state, one server-list query path, and shared
project-tree expansion. The old ingredient `presenceCondition` item was stale; that
implementation now uses `idSetPresence`.

- [ ] **Codegen the two eager-route filter mirrors.** `entities/sortable-fields.ts`
      and `entities/filter-search-fields.ts` re-describe what
      `packages/schemas/src/*.ts` already declares. They are hand-kept on
      purpose: importing every entity schema here pulls the validation graphs
      into the eager route tree, which is why the files exist at all. So the fix
      is a build-time projection, not an import — and `sortable-fields`' drift
      test would retire rather than stay load-bearing. The URL-key mirror is
      already pinned to the manifest by a property test, so only
      `sortable-fields` is genuinely unguarded (its test compares against a
      hand-written literal that itself needs a manual edit per new entity).
      Not worth a build step on its own; do it if a third mirror ever appears.

### Rejected

- **CF Workers cron triggers.** Every candidate was a backstop for a single user —
  recipe-totals drain, nightly USDA sweep, soft-delete/audit retention purge, costing
  drift check. The client poll plus the Settings maintenance backfill already
  cover the drain; the rest doesn't earn a `scheduled` handler that can't be exercised
  under `vite dev` (Miniflare or prod only). Revisit only when something actually rots
  unattended. (Inventory expiry flagging is separately dead — see Meal planning v2's
  Rejected block.)
- **Queueing rare interactive work**, per [tenet 3](../README.md#tenets): cookbook
  EPUB import (per-chunk `assemble_recipes` with retries + DLQ) and the scraped/Notion
  hero-image import both run a handful of times with a human waiting. They stay
  synchronous; the hero-image fix is a plain inline call — see
  [Recipes & Import](#recipes--import).
- **A `defineDetector` registry for Problems.** The recurring suggestion is to
  collapse each detector's five-step ritual (SQL in `repo/problems/detectors-*.ts`,
  schema + shape key + `PROBLEM_CLASS` entry, `problems/index.ts` re-export,
  `problems.service.ts` fan-out, `problem-sections.tsx` section) into one
  declaration. Measured before rejecting: **42 keys across 34 sections**, and a
  registry would have to carry cost group, extra constructor args, env gating
  (`semanticEmbeddingsConfigured`), fan-out shape (one detector → 1, 2, or 7
  keys), section ordering (carried by array position today), and **14 sections'
  bespoke React** — `unit-coverage` alone is a 4-way branch over a discriminated
  union merged from 3 keys, with different actions per branch. Detector
  signatures aren't uniform either (some take extra args, some return objects
  rather than arrays, some are sourced outside the problems barrel). Against
  that, the registry would have to preserve the four cost groups, the
  `PROBLEMS_HOT_PATH_PROCEDURES` splitLink routing that gives each group its own
  Worker CPU budget (the old monolithic scan blew the 30s limit), and
  `traceAllSeq`'s sequential execution on a pinned connection. The two drift
  holes that actually mattered were welded structurally in #675 without a
  registry: `PROBLEM_CLASS` now types the UI's coverage declaration, and the 42
  hand-written merge defaults are derived. Revisit only if the per-detector
  ritual starts producing real bugs rather than boilerplate.
