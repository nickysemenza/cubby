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

- [ ] **Actionable missing-weight links**: the total-weight anchor needs every
  line to convert to grams. Gaps already surface via `totals.missingByType.weight`
  and the scale popover shows a passive "No weight conversion yet…" notice. Make it
  actionable: list the offending ingredient(s) and deep-link to where the mapping
  is actually edited — the **product** form (`product-form-fields.tsx`, the
  `unitMappings` `ArrayFieldManager`), **not** the ingredient page
  (`ingredient-detail.tsx` is read-only `UnitMappingsTable`). Since a line resolves
  to an ingredient that may have multiple products, link straight to the product
  edit form when the ingredient has exactly one product, else via `/ingredients/$id`
  (the hub that lists its products). Reuse `UnitMappingDisplay` / `ConversionDialog`.
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
