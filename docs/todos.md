## Future: WASM Conversion Capabilities

Now that all unit conversions go through WASM with compound unit support:

- [ ] **Price per nutrient**: Add "g protein → cent" mappings to calculate cost per gram of protein
- [ ] **Daily value %**: Add "mg vitamin_c → % daily_value" mappings for nutrition labels
- [ ] **Nutrient density comparisons**: Compare foods by protein-per-calorie ratios directly
- [ ] **Batch ingredient parsing**: Parse entire recipe text and convert all amounts in one WASM call
- [ ] **Custom unit aliases**: User-defined "1 serving = X g" with automatic nutrient calculation
- [ ] **Inventory depletion preview**: "If I make this recipe, how much of each nutrient will I have left?"

## Future: Recipe Scaling — Density Coverage (Phase 2)

Follow-on to client-side recipe scaling (multiplier/weight/ingredient anchors,
`recipe-scaling.ts` + `RecipeScaleControl.tsx`). No new schema/table — fix data
organically via the existing per-product `UnitMapping` mechanism.

- [ ] **Salt convention**: distinct salts ("Diamond Crystal kosher salt" — already
  in data — "Morton", "table salt") each carry their own density mapping; bare
  "salt" defaults to table salt. Mostly data; document the default in `recipe-utils`.
  Low urgency — salt barely moves totals.

Parked: pan-size scaling, a global density reference table/seed, interactive
parse-clarification, and the baker's-% compare "X-ray".

## Future: Location Enhancements

- [ ] Add drag-drop between locations in tree view

## Architecture Improvements (from assumption review)

### Quick wins
- [ ] Document test placement criteria (unit vs integration vs e2e)

### Larger changes
- [ ] Simplify household sharing - replace organization plugin with simple household model (users share one household UUID, magic link invites, no hierarchy)

## Future: Recipe Import

- [ ] **Scraped/Notion image not persisted on the server import path**: the scrape *form* imports the image client-side via `image.importFromUrl`, but `insertImportRecipe`/`insertNotionRecipe` drop `ImportRecipe.image`. Fix: call the existing `importImageFromUrl(db, …)` (`apps/web/src/server/repo/image.ts`) during server-side import and attach the resulting image id. This is also the path for the deferred Notion hero-image import — note Notion image URLs are signed/expiring, so they must be fetched at import time.

## Future: Background Jobs (cron + queue)

CF Workers cron triggers + a CF Queue (free tier: 10k ops/day — plenty) would
let the web worker do server-side background work. Scoped 2026-06 and deferred:
not worth the moving parts for a single user yet. Pattern when revisited: a job
fn under `server/jobs/` reusing `buildCrudServices(db)`; handlers in
`cf-server.ts` (`scheduled`/`queue`) share a prelude (BETTER_AUTH_SECRET bridge,
`setCfEnv`, `withRequestDb`); producers gate on the binding's presence and fall
back to fire-and-forget inline in dev (no binding under `vite dev`), mirroring
`getBindingFetcher` in `cf-env.ts`. Note: cron/queue handlers can't be exercised
under plain `vite dev` — only `wrangler dev` (Miniflare) or prod.

Queue (offload slow/flaky user-triggered work):

- [ ] Persist scraped/Notion hero images async (see "Future: Recipe Import" above — strongest fit)
- [ ] Cookbook EPUB import: per-chunk LLM `assemble_recipes` with retries + DLQ
- [ ] USDA enrichment: retry instead of silently degrading to `null` when usda-api is down

Cron (periodic, no trigger):

- [ ] Recipe-totals drain backstop: self-heal `totalsComputedAt IS NULL` for off-page edits (reuse `RecipeCostingService.drainStale`); supplements the client poll + `recompute_recipe_totals` MCP backfill
- [ ] Nightly USDA enrichment sweep: backfill products missing USDA links
- [ ] Soft-delete + audit-trail retention purge (deletes are permanent UX-wise; the DB grows forever otherwise)
- [ ] Inventory expiry flagging into the problems indicator
- [ ] Costing drift health check on a timer (vs. manual parity runs)
