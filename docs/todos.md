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

Keep **Now** deliberately small. Promote one item into README's active slot when
work starts; do not treat this table as permission to work all rows in parallel.
Shape is a rough delivery size: S is one bounded surface; M crosses layers or
needs multi-surface verification.

| Order | Work | Why now | Shape |
|---:|---|---|---|
| 1 | [Empty locations stall a recount](#inventory--recount-2026-07-audit-residue) | Breaks a core inventory-maintenance flow; bounded fix | S |
| 2 | [Close the equivalences-report loop](#recipe-scaling--density-coverage-phase-2) | Turns an existing report into the data-repair path the costing model expects | M |
| 3 | [Persist imported recipe times](#recipe--cookbook-ux-2026-07-audit) | Stops dropping already-extracted data and adds the best weeknight decision axis | M |
| 4 | [Faster scanner lock-on](#mobile--pwa) | Improves the phone-first capture path; requires a real-iPhone acceptance pass | M |
| 5 | [Add a recipe to an existing meal](#meal-planning-v2) | Prevents one day/slot from fragmenting into duplicate meals | S–M |

### Next

Ordered within each domain only; choose based on which surface is seeing real use.

- **Recipe data:** ingredient editing parity, then macro-aware nutrition. The
  portion solver stays behind nutrition and real evidence that agent iteration is
  painful.
- **Shopping:** split Shopping list v1.5 into independently shippable slices:
  (1) manual items + durable check-off, (2) shopper units + pack rounding,
  (3) estimated cost, then (4) URL exclusions + text/print export.
- **House:** recurring maintenance; then the tracker data gaps as separate changes
  (`completedAt`, portfolio figures, mobile renderer, project History, activity
  filter), not one omnibus PR.
- **Small UX batch:** recipe clone, recipe QR labels, compare-page picker, and
  product bulk label printing. These may travel together only if their shared
  implementation surface makes the batch smaller than separate changes.

### Promote only when triggered

These are recorded options, not latent obligations. Their detailed entries name
the evidence required before promotion.

- UPC duplicate collapsing, aggregate-range materiality, Sentry lazy-init,
  selection-control consolidation, and all three additional MCP Apps.
- `ProjectTool`, `PurchaseLine`, `ExpenseProduct`, the service/product advisory,
  and repeat-purchase ranking.
- Product external-id collisions are **already queryable** through
  `product.externalIdCollisions`; revisit a broader Problems surface only if an
  auto-minting import creates a persistent operator worklist.
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

- [ ] **Close the equivalences-report loop** (2026-07 audit):
  `/ingredients/equivalences` harvests candidates and flags contradictions with
  existing mappings, then offers zero actions — no apply, no open-in-workbench,
  no dismiss, not even a link to the conflicting product. Give it the same
  `gapFixLinkProps` → workbench treatment the coverage popover has; that *is*
  the "fix density data organically" mechanism this section prescribes.
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

- [ ] **Persist recipe times on import**: scraper + EPUB already extract
  `importRecipeTimes {active,total,prep,cook}` plus `equipment` and `page`
  (`import-recipe.ts`), but persisted `recipeMeta` is `{ url }` only — the data
  is extracted then dropped. Persist, render on detail, sort/filter the list by
  total time (the #1 weeknight decision axis; gives meal planning an effort
  axis). `meta.page` is the natural cross-reference for a physical cookbook.
- [ ] **Recipe clone/duplicate** — still no `duplicate` in recipe crud.
- [ ] **Recipe QR labels**: shortcodes are minted on every create and
  `$shortcode.tsx` resolves `R-XXXX`, but the detail page never shows the code
  and `use-shortcode-lookups.ts` only knows location/product, so `/labels`
  can't print recipe QRs. Completes an already-shipped mechanic.
- [ ] **Cookbook lifecycle**: no rename/metadata edit (a mangled OPF title is
  permanent); identity is keyed on `name` (same-title books collide, a re-titled
  EPUB forks a duplicate — needs merge/re-point); `subjects` is stored + on the
  wire but rendered nowhere (free browse facet); list has no search/sort/filter
  (incl. a "partially imported" filter from `sourceRecipeCount - recipeCount`).
- [ ] **Kitchen-mode persistence**: step check-off is `useState` in
  `RecipeInstructions` — lost on nav or scale change; no ingredient check-off in
  Read view; no timers derived from step text.
- [ ] **Export "Read" format**: the print/export sheet offers prep/nested/matrix
  (all spec-flavored) but no plain recipe-as-a-page format
  (`RecipeMagazineView` would drop in); no multi-recipe/cookbook export.
- [ ] **Compare page picker**: "Add Another Recipe" navigates to `/recipes` and
  loses the selection; add an on-page picker.
- [ ] **Notion importer hygiene**: `staleTime: 0` full-DB refetch on every
  visit, every row runs WASM parses, no status filter/search/virtualization.

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
- [ ] **Replace `NutritionInfoTable` with `NutritionLabel`** on the USDA food pages —
  the FDA-style label (with %DV) now coexists with the raw nutrient table on
  product detail; decide whether the raw table still earns its place. (2026-07
  audit: ingredient detail is a *third* raw-table instance.)
- [ ] **USDA food detail is a read-only dead end** (2026-07 audit): no page
  actions at all — add "create product from this food" / "link to an
  ingredient", since the food page is where the `ingredient → product → fdc_id`
  hop naturally closes.
- [ ] **Nutrient-density intel beyond recipes**: `nutrition-intel.ts`
  (`costPerNutrient`, `proteinPer100Kcal`) renders only in magazine view +
  compare; product/ingredient/USDA pages — where "cost per g protein" drives
  the buying decision — don't show it.
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
- [ ] **Retry USDA enrichment instead of silently degrading to `null`** when usda-api
  is down — a small job kind on the background queue that already exists
  (`server/background-queue.ts`), not new infrastructure.

---

## Mobile / PWA

App-shell service worker, critical-bundle trimming, route skeletons, iOS
camera-permission recovery, and the bundled ZXing scanner (`barcode-detector`, no
runtime CDN) are all shipped. Target is iOS Safari only. Remaining:

- [ ] **B1 — faster scanner lock-on**: detection currently runs `detector.detect(video)`
  on the full frame every `requestAnimationFrame` and takes `results[0]`
  (`useBarcodeScanner.ts`). Throttle to ~10–12 Hz, crop the central scan-box region to a
  small offscreen canvas (must track the *displayed* reticle box, accounting for
  `object-fit` on the `<video>`, or it decodes the wrong region), and pick the
  most-central result when several are detected. Extract the ROI/throttle helper as a
  pure function and unit-test it; verify lock-on feel manually on a real iPhone.
- [ ] **B3 — continuous multi-add feedback**: a running tally + recently-scanned chip
  list in `persistent-scanner.tsx`, so a grocery haul can be ripped through without
  watching the form (the per-add success pulse already exists there).
- [ ] **C3 — residual N+1 audit**: sweep products/recipes/inventory-detail for per-row
  query fans and batch them the way `getByLocationIds` did. Network panel should show a
  constant query count regardless of row count. Timeboxed. Flagship instance
  (2026-07 audit): `location-gallery.tsx` calls `useAllInventoryItems()`, which
  auto-paginates the **entire inventory table** to the client on the default
  Locations view — `location.makeTree` counts + `location.valuation` +
  `inventory.getCountsByLocations` already provide the data server-side.
- [ ] **Sentry lazy-init (optional)**: init in `router.tsx` is already client-only with
  dev tracing/replay disabled and replay prod-only; if ever picked up, run a temporary
  `rollup-plugin-visualizer` treemap first to confirm it's still the biggest
  critical-path item.

---

## Inventory & recount (2026-07 audit residue)

- [ ] **Empty locations stall a sweep**: `flattenAuditableLocations` includes
  every descendant regardless of content, so a room of 15 empty bins is 15
  zero-row "Save recount" stops. Bulk "mark remaining empty bins verified" or
  auto-advance.
- [ ] **Problems detectors for meals + cookbooks**: partially-imported cookbooks
  (`sourceRecipeCount > recipeCount` — visible only if you open that book),
  empty meals, meals whose recipes have no totals, recipes with zero
  instructions.
- [ ] **Products list bulk print-labels**: locations table has the bulk action,
  products has per-row only, and the `/labels` empty state promises both.
- [ ] **AiSearchBar on inventory is thinner than the plain filters**: it can
  only set `productName`/`locationName` — the two substring filters already on
  screen. Either teach it quantity/category/valuation/verified-before/subtree
  filters or drop it from that surface.

---

## Meal planning v2

v1 shipped — calendar (week + table), per-meal scaling, and a display-only shopping
list (need vs. on-hand). The shopping list stays **display-only**: it reads inventory,
it never writes it. Deferred:

- [ ] Meal labels, recurring meals, meal templates, nutrition goals (each its own
  future slice).
- [ ] **Shopping list v1.5** (2026-07 audit — all display-layer, tenet-safe):
  manual/ad-hoc items ("milk, paper towels" — without them it can't be *the*
  list you take to the store); estimated trip cost (the costing engine's most
  glaring absence — `shoppingListItem` carries need/have/shortfall but no
  price); shopper-friendly units + pack rounding (raw `basisUnit` prints
  "1360 g flour"); durable check-off state (today localStorage keyed by exact
  date range — nudging the range wipes mid-shop progress, and it doesn't follow
  desktop→phone); excluded-meal toggles into the URL; copy-as-text/print.
- [ ] **"Add to meal" should join an existing meal**: `add-to-meal.tsx` always
  `meal.create`s, so adding two recipes to Tuesday dinner makes two meals. Offer
  the day's existing meals (and a slot/name) before creating. Related unused
  affordances: `Meal.sortOrder`/`MealRecipe.sortOrder` are written and ordered
  by but no UI reorders; no meal-type concept beyond free-text `name`.
- [ ] **Calendar ergonomics**: move a meal to another day / duplicate / copy
  last week without a detail-page round-trip; a phone agenda view (the week grid
  degrades to seven stacked `min-h-32` cards); "+ Meal" shouldn't navigate away
  from the calendar mid-layout.
- [ ] **Suggestions page follow-ups**: make cards actionable (link missing
  ingredients to their fix surface, "add the missing 2 to the shopping list");
  reachable from home/inventory, not just the nav dropdown.

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
- [ ] **Make project portfolio expense charts honor ledger filters.**
  `repo/project/portfolio-analytics.ts` hand-rolls date bounds from a different
  input schema, so `costMin`/`costMax`/`notesSearch`/`urlSearch` and OR-search do
  not reach it. Route the expense-grouped aggregates through the shared expense
  filter builder without changing the separate project-set filters.
- [ ] **Tracker data gaps** (2026-07 audit): `task.completedAt` (velocity /
  "year in the house" + de-noises the stalled-project detector — `updatedAt`
  resets on any edit); portfolio-level estimate
  total + a forward committed-spend (next 30/60/90d) figure (per-project
  `BudgetStrip` exists, the portfolio equivalent doesn't; the `credits` value
  portfolio-analytics computes in SQL is dropped at the schema boundary); mobile
  fallback for TaskBoard/Gantt (desktop column tracks render on phones today);
  project-detail History section (manifest declares it, the hand-rolled page
  drops it); activity-page `entityType` filter (API accepts it, no control).
- [ ] **`projectMaterial` BOM**: on top of the bridge — quantity + free-text unit,
  optional product resolution, durable-vs-consumable flag → **have / need / buy**
  per project via the availability engine, shopping list from shortfalls. No
  reservations, no auto-decrement — audits are the backstop, "mark consumed" is an
  optional explicit action.

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

- [ ] **`ProjectTool`** (`projectId`, `productId`) → cost-per-use = net basis ÷ usage
  count. **Trigger**: wanting a real cost-per-use number. Amortized tool cost is
  informational ONLY and must never enter project actuals — the expense already sits
  in its buying project's ledger (double-count guard). Depends on nothing else.
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
aggregate credits (`lowes returns` −$77.46), and deposit/balance pairs — and those should
be unbundled per the existing `splitExpense` path, each part taking its own product. That
is not a new feature; it is Phase 3 of the purchase-import skill, now stated explicitly
there. Two classes are genuinely never products: **service/labor lines** (no object, and
`Expense.productId` is an `acquisition` edge whose net-cost derivation a labor line would
inflate — work *about* a product is `Task.subjectProductId`) and **installments**
(`hotel payment 3/11`, `retaining wall 2/2` — that grouping is the purchase and the project).

- [ ] **`servicesWithProduct` advisory detector** — mirrors `purchasesNotReconciling` in shape
  (soft worklist, not an error list). The 2026-07 audit found **zero** live rows, so any row
  appearing is a real regression rather than a backlog. Deliberately **not** a CHECK
  constraint: `costType` is an operator-assigned *reporting* dimension and is already
  inconsistent (`countertop deposit` is materials, `2nd half of countertop` is services —
  same vendor, same amount, same slab), and `update_expenses` batches can reclassify rows, so a hard
  constraint would fail a bulk reclassify mid-transaction with an error about products.
- [ ] **Repeat-purchase rollup** — `ProductExpenseHistory` already ships per-product on the
  detail page and the Products list exposes a linked-expense count. What's missing is
  ranking that cross-product view by purchase count or total (the current Expenses column
  intentionally cannot sort). **Trigger**: enough productized repeat buys to be worth
  ranking — 6 at the 2026-07 audit, so not yet.

**`PurchaseLine`'s trigger is still NOT met by this** (see the deferred phase above). Unbundling
that *moves money* is `splitExpense`, which exists and is money-bearing; `PurchaseLine` is
pure SKU/quantity annotation and creates no products. Don't reach for it to do this job.

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

- [ ] **Re-evaluate SSR for authenticated detail routes.** They are deliberately
  `ssr: false` today: the SSR tRPC client targets `http://localhost`, which Cloudflare
  returns as error 1003 instead of JSON, and that self-fetch has no request session
  context. Re-enable only after loaders use a direct server-side caller or a
  request-scoped origin with forwarded authentication, and a Cloudflare preview
  hard-refresh proves finance detail pages render. First confirm that SSR's initial
  render benefit is worth the complexity for this single-user PWA.
- [ ] **Document test placement criteria** (unit vs integration vs e2e)
- [ ] **Selection-control consolidation — non-form phase.** Form and inline-edit
  pickers share the Base UI assignment-picker shell; remaining selectors are
  intentionally specialized. If visual or keyboard inconsistencies remain painful,
  migrate table/header filters, pagination, gallery and workflow-scope filters, plus
  the remaining native selects in activity, cookbook, and background-jobs surfaces.
  Treat the ReUI advanced-filter builder as a separate high-risk phase: its static/
  async, single/multi, selected-first, nested-menu, and max-selection paths should
  converge on Base UI behavior before deleting its manual keyboard handling.
  Command palette and action menus are different interaction types and remain separate.
- [ ] **Budget-aware cursor pagination for wide MCP tool results.** MCP's native
  opaque-cursor pagination covers discovery operations such as `tools/list`, not
  arbitrary `tools/call` results, and `CallToolResult` carries no host context-window
  budget. Add tool-level `cursor` / `nextCursor` fields to the shared list plumbing,
  starting with `list_expenses`: use a stable keyset cursor so variable page sizes
  cannot skip or duplicate rows; treat `pageSize` as an upper bound while a
  configurable compact-JSON byte budget chooses the actual page; consume a future
  client budget hint if MCP standardizes one, otherwise keep the conservative
  server-owned byte budget. Invalid or filter/sort-incompatible cursors must fail
  explicitly rather than silently restarting from page one.

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
rather than only picking from the hardcoded three. Storage should follow the existing
per-entity table-state pattern — module cache + `localStorage` + `useSyncExternalStore`,
as in `useTableColumnVisibility.ts` / `useTableColumnSizing.ts`
(`table-columns:{entity}`). A saved view is the same shape `view-manifest.ts` already
uses, so `DataTableViews` should just render two groups.

Still not convertible, and this is by design: **Analytics, the task Board, and the
`/tasks` `history` tab are different *renderers* or non-column state** (`history` pins
`completion: "done"`, a schema enum with no column and no manifest spec). The switcher
has to keep those arms.

### Remaining from the filter-honesty audit

The semantic cleanup shipped: dashboard-scoped attention, shared task/expense bulk
workflows, honest infinite-list URL state, one server-list query path, and shared
project-tree expansion. The old ingredient `presenceCondition` item was stale; that
implementation now uses `idSetPresence`.

- [ ] **History view filtering/over-fetch.** `HistoryView` still owns local `useState`
      filters, which are unshareable unlike every other view on that page, and reads only
      `data.projects` from a payload that includes the attention computation.

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
