# Cubby — Work List

The canonical backlog — high-level goals with the load-bearing details inline.
Grouped by theme; every item is open/deferred. Design decisions and rejected
alternatives live next to the items they concern (there is no separate plans
directory — detail beyond what an item carries here gets re-derived at build
time, against the code as it exists then).

Everything here is bounded by the [Tenets](../README.md#tenets). An idea that
contradicts one belongs in a **Rejected** block, not in the open list.

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

The tracker module (projects / tasks / purchases) is feature-complete standalone —
including actionable-task reads, one-level checklist subtasks, and arbitrary-depth
sub-projects (a sub-project's `costEstimate` is the budget envelope for a
trade/phase, with subtree rollups on parents). The open work below connects it to
the rest of cubby. Schema affordances already in place for it: `task.projectId` is
nullable (inbox tasks) and `purchase.future` marks planned-not-yet-actual spend.
Roughly priority order.

- [x] **Purchases ↔ inventory bridge** — v1 shipped 2026-07 (`purchase.productId` +
  `purchase.vendor`, zero new tables); deferred phases + triggers in the subsection
  below. Foundation for the BOM.
- [ ] **Recurring maintenance tasks**: simple every-N-weeks/months interval on a
  template — not RRULE; next instance generated on completion; surfaces in
  needs-attention. (The rest of the old maintenance+budgeting bundle shipped
  2026-07: inbox view + promote-to-project, the attention detectors in
  `repo/project/attention.ts`, and the planned-vs-actual budget views.)
- [ ] **Surface the tracker to the rest of the app** (2026-07 audit): register
  the 6 attention detectors as a Problems group (the navbar badge, `/problems`,
  homepage banner, and `list_problems` MCP are tracker-blind today); quick-capture
  Add Task/Project/Purchase in the navbar-create + palette registry (House is the
  only domain with no quick-add path); a House tile on the home dashboard over
  the currently-unused `task.summary`; MCP synthesis tools (`get_house_status`
  over `project.dashboardSummary`, task/purchase analytics + bulk tools — the
  tracker has CRUD-only MCP while the food domain has nine specialized tools).
- [ ] **Tracker data gaps** (2026-07 audit): `task.completedAt` (velocity /
  "year in the house" + de-noises the stalled-project detector — `updatedAt`
  resets on any edit); ~~purchase `vendor`~~ shipped as a column in bridge v1
  (spend-by-vendor analytics still open, see below) and the receipt **image** waits
  on the `Receipt` phase; portfolio-level estimate
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

### Purchases ↔ inventory bridge (staged; v1 SHIPPED 2026-07)

Ground truth that shaped the staging: tools **already are** products (74 `tools`
products, 68 inventoried, 79/94 tool-ish products priced — the garage valuation
rollup works today), and coarse multi-trade runs are **already split by hand** —
201 of 369 dated days carry more than one purchase row, 151 span more than one
trade. Only 33 of 268 `tools` purchases fuzzy-match an existing product name, so a
product link is sparse and stays opt-in. Hence v1 is two nullable columns and zero
new tables; everything below it is additive, behind an explicit trigger.

**v1 (shipped)** — `purchase.productId` + `purchase.vendor`. Link a purchase to a
product (opt-in; services/materials stay unlinked), explicit
**receive-into-inventory** from a linked purchase (never automatic — the mirror of
the no-auto-decrement tenet), purchase history + derived net cost on the product
page, vendor on the ledger. Linked purchases double as price observations —
read-only history first; promoting into `product.price` stays a later explicit step.

**The lifecycle convention is the load-bearing part and costs zero schema**: every
exit is a *terminal negative purchase carrying the same productId* — sale at sale
price, return at full price, broken/gifted as a **$0 purchase** (never null: `cost
IS NULL` is the Unclassified predicate) — plus an explicit inventory decrement.
Money is derived as `splitPurchaseSpend(rows).actual - .contributions` (NOT `.net`,
which folds in `future` rows); **owned/sold comes off `inventoryEntry`, never off
purchase signs** (two buys + one sale nets positive — the sign is ambiguous). No
status column, no disposition enum, no `Sold` location.

Deferred phases — each purely additive on top of v1, with its promotion trigger:

- [ ] **`ProjectTool`** (`projectId`, `productId`) → cost-per-use = net basis ÷ usage
  count. **Trigger**: wanting a real cost-per-use number. Amortized tool cost is
  informational ONLY and must never enter project actuals — the purchase already sits
  in its buying project's ledger (double-count guard). Depends on nothing else.
- [ ] **`Receipt`** (`vendor`, `date`, `imageId?`, `statedTotal?`) + nullable
  `purchase.receiptId`, turning today's hand-split rows into a labelled group.
  **Trigger**: a receipt photo with nowhere to live, or reconciling one card charge
  against N rows. Additive — old purchases keep `receiptId` null and `vendor` migrates
  off the v1 column onto the receipt.
- [ ] **`ReceiptLine`** (`receiptId`, `name`, `sku?`, `quantity?`, `unitPrice?`,
  `purchaseId?` soft-link) — optional SKU-level itemization, **pure annotation**:
  rollups only ever read `Purchase`, lines need no product, and a sum mismatch is a
  soft display-level flag, never enforced. **Trigger**: actually wanting store SKUs.
- [ ] **`PurchaseProduct`** join + `quantity`, replacing `purchase.productId`.
  **Trigger**: a purchase genuinely needing 2+ products (combo kit), or a correct
  unit-price observation on a multi-quantity buy. Mechanical migration: insert-select
  from the non-null column, drop it, update read sites.
- [ ] **Spend-by-vendor** analytics — a `byVendor` aggregate mirroring `byProject` in
  `repo/purchase/analytics.ts` + a chart. Cheap; deferred only for scope.

Two traps this design already walked into once — don't re-introduce them:
`buildSearchConditions` **ANDs** its `searchFilters`, so vendor must never share the
`search` term (it would mean `name ILIKE q AND vendor ILIKE q`, and vendor is null on
nearly every row → search silently returns nothing). And `InventoryEntry` has a
partial unique index on `(productId, locationId)`, so the receive flow **must** branch
(create / top-up existing / move a unique item) rather than blind-inserting.

Rejected within this design: **`Asset` entity** (a fixed-asset register would duplicate
the live inventory layer for location/valuation/audits and guarantee sync drift; pooled
cost basis on identical tools is consciously accepted; it layers on later without
unwinding v1); **`Sold` virtual location** (pollutes valuation and audits — "former
tools" is a query, not a place); **line items as financial truth** (a header/lines split
when 95% of purchases are single-trade); **disposition status enum** (the $0-exit
convention makes it derivable).

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

- **Ranged estimate purchases** (`costLow`/`costHigh` + a one-click settle) — modeled
  an estimate as a proto-purchase, but in practice an estimate ("electrical is
  10–15k") is an *envelope* that dozens of real purchases accrue against; nothing
  settles 1:1. The envelope home is a **sub-project** with the existing single-point
  `costEstimate`; actuals attribute via `projectId`. No ranges anywhere, for now.
- **Monarch / finance sync** — purchases stay a hand-curated ledger.
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

- [ ] **Document test placement criteria** (unit vs integration vs e2e)

### Integration suite — provision the test DB per file, not per test

`withTestDb()` (apps/web/tooling/test-setup.ts) registers a **`beforeEach`** that calls
`buildTestDB()`, so every one of the ~294 integration tests pays a full
`CREATE DATABASE ... TEMPLATE` round-trip through IntegreSQL. Measured on an 8-core
NVMe box: `getTestDatabase` is ~43ms running a single file alone, but **mean 788ms /
p99 1.9s** across the parallel full suite. On CI's slower disk the tail crossed the
10s hook timeout and failed ~8% of runs (both shards, every branch) with
"Hook timed out in 10000ms" on an arbitrary scatter of tests.

Mitigated 2026-07-27 by raising `hookTimeout` to 30s (apps/web/vitest.config.ts) —
that stops the flake but not the cost: provisioning is a large share of the suite's
work (292 × ~790ms against a 62s wall-clock).

The structural fix is a per-**file** database (`beforeAll`) with truncation between
tests, taking 294 provisions down to 35. Deferred because it changes the isolation
contract every test currently relies on (a pristine DB per test), so it needs a
deliberate pass over all 35 files rather than a mechanical swap — several seed
their own fixtures and would need the truncation order to respect FK cascades.

Measured and **rejected**: raising IntegreSQL's pool size. With
`INTEGRESQL_TEST_INITIAL_POOL_SIZE` 8 → 32 the pool grew from 8 to 64 databases and
the distribution was unchanged (mean 777ms vs 788ms) — the wait is the per-database
CREATE cost, not queueing for a free slot. Memoizing the template hash is likewise
not worth it: `hashFiles` measures 1.4ms mean against a ~790ms hook.

### Background work — where it stands

The **queue is shipped**, not pending: `BACKGROUND_QUEUE` → `cubby-background` with a
DLQ (`apps/web/wrangler.jsonc`), the producer/consumer in
`apps/web/src/server/background-queue.ts`, a jobs repo + router, and the
`/background-jobs` batch page. Live job kinds are recipe-totals recompute, entity
embedding refresh, location AI description/inventory refresh, and location valuation.
Add a new kind there; don't re-scope "background jobs" as a project.

### Rejected

- **CF Workers cron triggers.** Every candidate was a backstop for a single user —
  recipe-totals drain, nightly USDA sweep, soft-delete/audit retention purge, costing
  drift check. The client poll plus the `recompute_recipe_totals` MCP backfill already
  cover the drain; the rest doesn't earn a `scheduled` handler that can't be exercised
  under `vite dev` (Miniflare or prod only). Revisit only when something actually rots
  unattended. (Inventory expiry flagging is separately dead — see Meal planning v2's
  Rejected block.)
- **Queueing rare interactive work**, per [tenet 3](../README.md#tenets): cookbook
  EPUB import (per-chunk `assemble_recipes` with retries + DLQ) and the scraped/Notion
  hero-image import both run a handful of times with a human waiting. They stay
  synchronous; the hero-image fix is a plain inline call — see
  [Recipes & Import](#recipes--import).
