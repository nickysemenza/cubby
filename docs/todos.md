# Cubby — Work List

The canonical backlog — high-level goals with the load-bearing details inline.
Grouped by theme; every item is open/deferred. Design decisions and rejected
alternatives live next to the items they concern (there is no separate plans
directory — detail beyond what an item carries here gets re-derived at build
time, against the code as it exists then).

---

## Recipes & Import

### Image not persisted on the server import path

- [ ] **Scraped/Notion image not persisted on the server import path**: the scrape
  *form* imports the image client-side via `image.importFromUrl`, but the server-side
  import (`apps/web/src/server/repo/import-recipe-convert.ts`) drops
  `ImportRecipe.image`. Fix: call the existing `importImageFromUrl(db, …)`
  (`apps/web/src/server/repo/image.ts`) during server-side import and attach the
  resulting image id. This is also the path for the deferred Notion hero-image import
  — note Notion image URLs are signed/expiring, so they must be fetched at import time.
  (Strongest fit for the async queue — see [Background Jobs](#background-jobs-cron--queue).)

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
- [ ] **Macro-aware nutrition (prereq for the above)**: add an ingredient-level USDA
  `fdc_id` link (today `fdc_id` lives only on `Product`; for nutrition you want a
  canonical per-ingredient link, falling back to the product's), auto-attach a
  best-guess FDC entry during resolve-or-create, and surface P/F/C/kcal per serving.

### Recipe scaling — density coverage (Phase 2)

Follow-on to client-side recipe scaling (multiplier/weight/ingredient anchors,
`recipe-scaling.ts` + `RecipeScaleControl.tsx`). No new schema/table — fix data
organically via the existing per-product `UnitMapping` mechanism.

- [ ] **Salt convention**: distinct salts ("Diamond Crystal kosher salt" — already
  in data — "Morton", "table salt") each carry their own density mapping; bare
  "salt" defaults to table salt. Mostly data; document the default in `recipe-utils`.
  Low urgency — salt barely moves totals.

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

Now that all unit conversions go through WASM with compound unit support:

- [ ] **Price per nutrient**: Add "g protein → cent" mappings to calculate cost per gram of protein
- [ ] **Daily value %**: Add "mg vitamin_c → % daily_value" mappings for nutrition labels
- [ ] **Nutrient density comparisons**: Compare foods by protein-per-calorie ratios directly
- [ ] **Batch ingredient parsing**: Parse entire recipe text and convert all amounts in one WASM call
- [ ] **Custom unit aliases**: User-defined "1 serving = X g" with automatic nutrient calculation
- [ ] **Inventory depletion preview**: "If I make this recipe, how much of each nutrient will I have left?"

### USDA edge search parity

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
list (need vs. on-hand). Deferred:

- [ ] **Phase 4 — cook / consume inventory**: `meal.markCooked({ mealId })` converts each
  scaled ingredient → inventory unit (WASM), deducts across entries in a transaction,
  deletes zeroed entries, and writes audit logs; no-inventory → log shortfall,
  conversion-fail → skip + warn. The `mealRecipe` schema already leaves room for `cookedAt`.
- [ ] Expiration-aware suggestions, FEFO consumption, meal labels, recurring meals,
  meal templates, nutrition goals (each its own future slice).

---

## Household tracker / ERP

The tracker module (projects / tasks / purchases) is feature-complete standalone;
the open work is connecting it to the rest of cubby. Two schema affordances already
exist for this: `task.projectId` is nullable (inbox tasks) and `purchase.future`
marks planned-not-yet-actual spend. Roughly priority order; sequencing between the
first three is undecided.

- [ ] **`list_actionable_tasks`**: a computed unblocked-tasks read over the existing
  dependency edges — repo query + MCP tool + "what can I do this weekend" view, with
  a transitive "why is this blocked" read. Highest value-per-effort item here; also
  the data the weekly standup agent (below) needs.
- [ ] **`task.parentTaskId` subtasks**: additive nullable self-FK; one level of
  checklist subtasks (`N/M` chip on the parent, parent status stays manual). Doubles
  as the punch-list convention. Cheap while the schema is young.
- [ ] **Ranged estimate purchases**: `costLow`/`costHigh` (nullable
  `doublePrecision`, additive only — dev DB is prod Neon), meaningful while
  `future`; `cost` stays the settled actual. A one-click *settle* records the actual
  and flips `future` off; the range is **retained after settling** —
  estimate-vs-actual accuracy is itself interesting data. Rollups
  (`repo/project/analytics.ts`) grow a planned envelope: `plannedLow/High =
  SUM(COALESCE(costLow|costHigh, other, cost))` over `future` purchases — stays a
  SQL aggregate, never denormalized. UI: range input when `future`, `$50–70k` /
  `≈ $60k` rendering distinct from settled costs, budget charts get a low–high band;
  MCP purchase tools accept + return the fields.
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
  detectors (overdue tasks, spend over `costEstimate`/envelope, stale `in_progress`
  projects with no recent activity, past-date un-settled `future` purchases);
  planned-vs-actual budget view (falls out of the envelope rollup — estimate band
  vs. committed vs. actual, monthly cash-flow projection from `future` dates).
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
- [ ] **Weekly standup agent**: scheduled brief — what moved, what's blocked and
  why, budget burn, what's schedulable this weekend given calendar + weather. Nearly
  free once `list_actionable_tasks` lands.
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

## Background jobs (cron + queue)

CF Workers cron triggers + a CF Queue (free tier: 10k ops/day — plenty) would
let the web worker do server-side background work. Scoped 2026-06 and deferred:
not worth the moving parts for a single user yet. Pattern when revisited: a job
fn under `server/jobs/` reusing `buildCrudServices(db)`; handlers in
`cf-server.ts` (`scheduled`/`queue`) share a prelude (BETTER_AUTH_SECRET bridge,
`setCfEnv`, `withRequestDb`); producers gate on the binding's presence and fall
back to fire-and-forget inline in dev (no binding under `vite dev`), mirroring
`getBindingFetcher` in `cf-env.ts`. Note: cron/queue handlers can't be exercised
under plain `vite dev` — only `wrangler dev` (Miniflare) or prod. (The two
`// TODO: enqueue …` markers in `server/api/routers/recipe.ts` are the producer
call sites waiting on this.)

Queue (offload slow/flaky user-triggered work):

- [ ] Persist scraped/Notion hero images async (see [Recipes & Import](#recipes--import) — strongest fit)
- [ ] Cookbook EPUB import: per-chunk LLM `assemble_recipes` with retries + DLQ
- [ ] USDA enrichment: retry instead of silently degrading to `null` when usda-api is down

Cron (periodic, no trigger):

- [ ] Recipe-totals drain backstop: self-heal `totalsComputedAt IS NULL` for off-page edits (reuse `RecipeCostingService.drainStale`); supplements the client poll + `recompute_recipe_totals` MCP backfill
- [ ] Nightly USDA enrichment sweep: backfill products missing USDA links
- [ ] Soft-delete + audit-trail retention purge (deletes are permanent UX-wise; the DB grows forever otherwise)
- [ ] Inventory expiry flagging into the problems indicator
- [ ] Costing drift health check on a timer (vs. manual parity runs)

---

## Locations

- [ ] Add drag-drop between locations in tree view

---

## Architecture / engineering

- [ ] **Document test placement criteria** (unit vs integration vs e2e)
