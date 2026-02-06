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
