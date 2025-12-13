## Refactor: ingredient-parser unit_mapping.rs

- [x] **Reuse parser module**: Created `parse_amount_string()` in `parser/helpers.rs` that handles "4 lb", "$5", "1/2 cup", etc. using nom + fraction parsing. `unit_mapping.rs` now uses this instead of duplicating parsing logic.
- [ ] **Add canonical_unit() method to Measure**: Currently we call `unit().to_str()` to get singular form, but `to_str()` is meant for display. Add a dedicated `canonical_unit() -> String` method that returns the singular unit without pluralization logic.

## Future: WASM Conversion Capabilities

Now that all unit conversions go through WASM with compound unit support:

- [ ] **Price per nutrient**: Add "g protein → cent" mappings to calculate cost per gram of protein
- [ ] **Daily value %**: Add "mg vitamin_c → % daily_value" mappings for nutrition labels
- [ ] **Nutrient density comparisons**: Compare foods by protein-per-calorie ratios directly
- [ ] **Batch ingredient parsing**: Parse entire recipe text and convert all amounts in one WASM call
- [ ] **Custom unit aliases**: User-defined "1 serving = X g" with automatic nutrient calculation
- [ ] **Inventory depletion preview**: "If I make this recipe, how much of each nutrient will I have left?"

## Enhanced Location Inventory Management

- **Quick Inventory Management from Location View**
  - Update `location-detail.tsx`:
    - Add inline "Quick Add" button for new inventory items
    - Add inline edit capabilities for quantities
    - Add "Move to..." action for individual items
    - Add delete action for removing items
  - Create `QuickInventoryAdd.tsx` component:
    - Compact inline form for adding products
    - Product search with amount input
    - Add without leaving location page

- **Additional Enhancements**
  - Add checkboxes to location table for bulk delete/move
  - Add drag-drop between locations in tree view (future)
  - Update `lastBulkInventory` timestamp on bulk operations
