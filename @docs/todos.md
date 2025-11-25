## consolidate unit conversions to use WASM everywhere (future optimization)
* **Current state**: Mixed approach with manual calculations + WASM
  - Manual: `scaleNutrientsByWeight()`, `calculateNutrients()`, array summing
  - WASM: Unit conversions via mappings and conversion graph
* **Opportunity**: Consolidate to use WASM for ALL conversions
  - Replace manual nutrition scaling with WASM graph traversal
  - Benefits: Single source of truth, automatic chained conversions (cups → ml → g → kcal), extensible for new nutrients
  - Challenges: Requires WASM/Rust changes (add "protein" MeasureKind), potential performance impact
* **Implementation**:
  - Add nutrition MeasureKinds to ingredient-parser Rust crate
  - Replace `scaleNutrientsByWeight` with `safeConvertAmount(w, amount, mappings, "calories")`
  - Replace `calculateNutrients` with WASM-based version
  - Keep array operations manual (WASM can't sum arrays)
* **Decision**: Current working solution is good. Consider full consolidation only if we need complex nutrition conversions or are already updating WASM code.

## Enhanced Location Inventory Management

* **Quick Inventory Management from Location View**
  - Update `location-detail.tsx`:
    - Add inline "Quick Add" button for new inventory items
    - Add inline edit capabilities for quantities
    - Add "Move to..." action for individual items
    - Add delete action for removing items
  - Create `QuickInventoryAdd.tsx` component:
    - Compact inline form for adding products
    - Product search with amount input
    - Add without leaving location page

* **Additional Enhancements**
  - Add checkboxes to location table for bulk delete/move
  - Add drag-drop between locations in tree view (future)
  - Update `lastBulkInventory` timestamp on bulk operations
