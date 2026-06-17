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
(shipped 2026-06-15). Both are downstream of macro-aware nutrition: once a
`get_recipe_nutrition(recipeId, servings) → {P,F,C,kcal}` tool exists (and ingredients
auto-link to a USDA FDC entry on creation), much of the portion solver dissolves into an
agent loop and the prep-sheet becomes mostly templating.

- [ ] **Portion solver**: a tool that takes a recipe + macro constraints (e.g. `<850
  kcal, >60g protein`, "lighter for person X") and solves the component gram weights in
  one shot, instead of the agent hand-iterating amounts. Niche; largely subsumed by the
  agent once `get_recipe_nutrition` makes macros queryable. Build only if the
  iterate-and-recheck loop stays painful in practice.
- [x] ~~**Recipe → prep-sheet export**~~ — shipped as a **UI feature**, not an MCP tool:
  three recipe-detail views — `prep` (components + combined shop), `nested` (Modernist-Cuisine
  spec), and `matrix` (ingredient × component grid, row totals = combined shop) — plus a
  print/export route (`/recipes/$id/export`) with Print + Copy-Markdown for each. All expand
  the full sub-recipe closure (`recipe-tree.ts` + `useRecipeTree`); prep quantities are
  as-used scaled, nested shows each batch at its own 100% base.
- [ ] **Macro-aware nutrition (prereq for both above)**: add an ingredient-level USDA
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

---

## Mobile / PWA

See [docs/plans/2026-06-02-mobile-web-implementation-plan.md](plans/2026-06-02-mobile-web-implementation-plan.md)
for the full plan (app-shell service worker, critical-bundle, and route-skeletons
already shipped). Remaining:

- [ ] **Scanner B1 — faster lock-on**: throttle detection to ~10–12 Hz, region-of-interest
  crop on the central scan box (offscreen canvas), pick the most-central result when
  multiple are detected. (`useBarcodeScanner.ts`)
- [ ] **Scanner B2 — honest iOS permission recovery**: iOS Safari won't re-prompt once
  camera is denied; detect the denied state and show the Settings → Safari → Camera fix
  instead of a silently-failing `retry()`.
- [ ] **Scanner B3 — continuous multi-add feedback**: running tally / recently-scanned
  chip list + a success pulse per add, so a grocery haul can be ripped through without
  watching the form.
- [ ] **C3 — residual N+1 audit**: sweep products/recipes/inventory-detail for per-row
  query fans and batch them the way `getByLocationIds` did. Timeboxed.
- [ ] **Self-host the scanner ZXing WASM** (loads from jsDelivr CDN today → not precached
  by the service worker; self-hosting enables faster first scan + offline scan).
- [ ] **Trim eager Sentry init** in `router.tsx` (replay integration is the heavy part,
  already prod-only-sampled); a temporary `rollup-plugin-visualizer` treemap would
  confirm the next-biggest critical-path items first.

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
- [ ] **Simplify household sharing** — replace organization plugin with a simple
  household model (users share one household UUID, magic-link invites, no hierarchy).
  Cross-cutting: scopes **all** entities uniformly in one migration, not bolted onto meals.
