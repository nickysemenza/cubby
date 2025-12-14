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
  - ~~"Quick Capture Here" button exists~~ (navigates to `/inventory/quick-capture?locationId=X`)
  - Update `location-detail.tsx`:
    - [ ] Add inline edit capabilities for quantities
    - [ ] Add "Move to..." action for individual items
    - [ ] Add delete action for removing items
  - [ ] Create `QuickInventoryAdd.tsx` component:
    - Compact inline form for adding products without leaving location page
    - Product search with amount input

- **Additional Enhancements**
  - [ ] Add checkboxes to location table for bulk delete/move
  - [ ] Add drag-drop between locations in tree view (future)
  - Update `lastBulkInventory` timestamp on bulk operations
