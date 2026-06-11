## Future: Agent ("Ask Cubby")

- [ ] **`find_cookable_recipes` tool**: Add a `server.tool("find_cookable_recipes", …)` in `apps/web/src/server/mcp/server.ts` that cross-references `recipe.list` ingredients against current inventory, so "what can I make tonight?" works in ⌘K and for external MCP clients. The agent runtime + bridge already pick up any new MCP tool automatically (subject to the read-only allowlist — `find_` is allowed).

## Future: WASM Conversion Capabilities

Now that all unit conversions go through WASM with compound unit support:

- [ ] **Price per nutrient**: Add "g protein → cent" mappings to calculate cost per gram of protein
- [ ] **Daily value %**: Add "mg vitamin_c → % daily_value" mappings for nutrition labels
- [ ] **Nutrient density comparisons**: Compare foods by protein-per-calorie ratios directly
- [ ] **Batch ingredient parsing**: Parse entire recipe text and convert all amounts in one WASM call
- [ ] **Custom unit aliases**: User-defined "1 serving = X g" with automatic nutrient calculation
- [ ] **Inventory depletion preview**: "If I make this recipe, how much of each nutrient will I have left?"

## Future: Location Enhancements

- [ ] Add drag-drop between locations in tree view

## Simplify Data Loading

- [ ] Replace inventory CSV import with direct tRPC calls in `load-data.ts` — the CSV import pipeline (`csv-import/`, `inventoryCSVRow` schema, `parseInventoryCSV`, papaparse dep) only exists to serve `load-data.ts` and its integration tests. A simpler approach: call `inventory.create` / `product.create` mutations directly, skip the CSV parsing/diffing layer entirely.

## Architecture Improvements (from assumption review)

### Quick wins
- [x] Simplify CLAUDE.md - remove low-value prescriptions that limit flexibility (230→85 lines)
- [ ] Document test placement criteria (unit vs integration vs e2e)

### Larger changes
- [ ] Simplify household sharing - replace organization plugin with simple household model (users share one household UUID, magic link invites, no hierarchy)

## Future: Recipe Import

- [ ] **Scraped page URL not stored as source**: the WASM→`ImportRecipe` scraper bridge (`WCompactToImportRecipe`, `apps/web/src/server/utils/scraper.ts`) never sets a real source URL, so URL/MCP-imported recipes (`insertCompactRecipe`) land as `SourceType=Other` with no source link. Fix: carry the scraped URL on `ImportRecipe` and have the import converter set `meta.url` from it, guarded to `http(s)` so a cookbook's synthetic `source#doc_path` stays null. (The recipe form's own URL field already covers the interactive scrape path.)
- [ ] **Scraped/Notion image not persisted on the server import path**: the scrape *form* imports the image client-side via `image.importFromUrl`, but `insertCompactRecipe`/`insertNotionRecipe` drop `ImportRecipe.image`. Fix: call the existing `importImageFromUrl(db, …)` (`apps/web/src/server/repo/image.ts`) during server-side import and attach the resulting image id. This is also the path for the deferred Notion hero-image import — note Notion image URLs are signed/expiring, so they must be fetched at import time.
