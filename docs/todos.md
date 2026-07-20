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

---

## Nutrition & cost intelligence (WASM conversion)

Price-per-nutrient, daily-value %, nutrient-density comparisons, batch ingredient
parsing (`parse_ingredient_lines`), and custom serving aliases all shipped. Remaining
follow-ups:

- [ ] **Replace `NutritionInfoTable` with `NutritionLabel`** on the USDA food pages —
  the FDA-style label (with %DV) now coexists with the raw nutrient table on
  product detail; decide whether the raw table still earns its place.
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
  constant query count regardless of row count. Timeboxed.
- [ ] **Sentry lazy-init (optional)**: init in `router.tsx` is already client-only with
  dev tracing/replay disabled and replay prod-only; if ever picked up, run a temporary
  `rollup-plugin-visualizer` treemap first to confirm it's still the biggest
  critical-path item.

---

## Meal planning v2

v1 shipped — calendar (week + table), per-meal scaling, and a display-only shopping
list (need vs. on-hand). The shopping list stays **display-only**: it reads inventory,
it never writes it. Deferred:

- [ ] Meal labels, recurring meals, meal templates, nutrition goals (each its own
  future slice).

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

- [ ] **Purchase ↔ product / inventory bridge**: optional `purchase.productId` FK
  (services/one-offs stay unlinked); a convert-to-inventory flow on a settled
  purchase (pick/create product + location → `InventoryEntry` via the existing
  capture path, purchase keeps a pointer to what it produced). Linked purchases
  double as **price observations** — read-only purchase history on the product page
  first; promoting into `product.price` is a later explicit step. New delete/convert
  paths honor the removal-path invariant (embedding cleanup in-transaction).
  Foundation for the BOM below.
- [ ] **Maintenance + budgeting** (semi-independent, in value order): recurring
  maintenance tasks (simple every-N-weeks/months interval on a template — not RRULE;
  next instance generated on completion; surfaces in needs-attention); an inbox view
  for project-less tasks + quick capture + "promote to project"; tracker Problems
  detectors (overdue tasks, subtree spend over a (sub-)project's `costEstimate`,
  stale `in_progress` projects with no recent activity, past-date un-settled
  `future` purchases); planned-vs-actual budget view (per sub-project:
  `costEstimate` envelope vs. committed vs. actual via the subtree rollup,
  monthly cash-flow projection from `future` dates).
- [ ] **`projectMaterial` BOM**: on top of the bridge — quantity + free-text unit,
  optional product resolution, durable-vs-consumable flag → **have / need / buy**
  per project via the availability engine, shopping list from shortfalls. No
  reservations, no auto-decrement — audits are the backstop, "mark consumed" is an
  optional explicit action.

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
- **Purchaser as an entity** — `nicky|rebecca|both` stays a hardcoded enum.
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
