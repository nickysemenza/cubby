# Cubby — Work List

The canonical backlog. Grouped by theme; every item is open/deferred. Detailed,
sequenced plans for the larger efforts live in [docs/plans/](plans/) and are linked
from the relevant section — this file is the index, the plans are the depth.

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

The tracker module (projects / tasks / purchases) is feature-complete standalone; the
open work is connecting it to the rest of cubby. Depth lives in two plan docs — [the
ERP roadmap](plans/2026-07-18-household-erp-roadmap.md) (near-term, specced) and [the
long-term backlog](plans/2026-07-18-cubby-long-term-backlog.md) (north-star tiers).
Sequencing between the Tier 0 items and ERP §1 is deliberately undecided.

- [ ] **`list_actionable_tasks`** (Tier 0): a computed unblocked-tasks read over the
  existing dependency edges — repo query + MCP tool + "what can I do this weekend"
  view, with a transitive "why is this blocked" read.
- [ ] **`task.parentTaskId` subtasks** (Tier 0): additive nullable self-FK; one level
  of checklist subtasks with an `N/M` chip on the parent.
- [ ] **Ranged estimate purchases** (ERP §1): `costLow`/`costHigh` on `future`
  purchases, a one-click settle action, planned-envelope rollups + budget-band charts.
- [ ] **Purchase ↔ product / inventory bridge** (ERP §2): optional
  `purchase.productId`, convert-to-inventory flow, purchases as price observations.
- [ ] **Maintenance + budgeting** (ERP §3): recurring maintenance tasks, inbox view
  for project-less tasks, tracker Problems detectors, planned-vs-actual budget view.

Beyond these, the long-term backlog doc holds the later tiers (synthesis views,
ambient capture, Home Assistant integration, digital twin) and the
explicitly-rejected list.

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
