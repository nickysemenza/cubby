
## ✅ differentiate between summing to 0 and/or partially missing 
* ~~In the recipe summary. If we have some or all ingredients w/ 'Missing Data' then we might sum the cost/weight/cal/protein to a partial number (or 0 if all are missing the data point). We should cleanly differentiate between these scenarios beyond just shoving into the 'Missing Data' section (missing: string[];)~~
* **COMPLETED**: Recipe summaries now show:
  - Complete data: "$12.50"
  - No data: "No data available" 
  - Partial data: "$8.30 (3/5 ingredients)"
  - Missing data grouped by type: "Missing Data: Price (chicken, oil), Weight (salt)"
## ✅ add table debug column
* ~~Let's add a column (default hidden) on all tables that launches a `Dialog` that shows the raw json data of the given row.~~
* **COMPLETED**: Global debug toggle system implemented:
  - Debug toggle button in navigation (bug icon) 
  - Debug columns automatically appear on all tables when enabled
  - Dialog shows formatted JSON data with copy functionality
  - Persistent setting saved to localStorage
  - Responsive design for mobile and desktop
  - Centralized implementation in Table component
## make tables look better on mobile
* right now they are really wide and you have to laterally scroll.
## when querying USDA and we are logged out it just appears to not load
* server says `tRPC failed on usda.list: UNAUTHORIZED` but i think we just return null i think? and the table just shows `No results.`. Seems like we aren't passing through the error state all the way?

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
* **Bulk Move Operations Between Locations**
  - Create `/inventory/bulk-move/page.tsx` - Bulk move interface  
  - Create `BulkMoveForm.tsx` component:
    - Source location selector
    - Multi-select for inventory items with checkboxes
    - Target location selector
    - Preview of items to be moved
    - Quantity adjustment option for partial moves
  - Add `bulkMove` procedure to inventory router:
    - Move multiple items in single transaction
    - Update quantities at both locations
    - Handle partial moves (e.g., move 5 of 10 units)

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

* **Inventory Value Totals**
  - Create `InventoryValueSummary.tsx` component:
    - Calculate total value using price mappings (e.g., "$5 = 1 lb")
    - Show breakdown by product category
    - Display "No pricing data" for items without mappings
  - Create `calculateInventoryValue.ts` utility:
    - Use WASM conversion to convert amounts to prices
    - Sum values across all products
    - Handle missing price data gracefully
  - Update `LocationCardGrid` and `location-detail.tsx`:
    - Show total inventory value on location cards
    - Add value summary section to location detail

* **Additional Enhancements**
  - Add checkboxes to location table for bulk delete/move
  - Add drag-drop between locations in tree view (future)
  - Update `lastBulkInventory` timestamp on bulk operations

## Schema Consistency Issues

### Make Optional Fields Required with Empty Defaults
Several fields are marked as `.optional()` but are always present (just sometimes empty). These should be made required with empty array defaults:

- [ ] Change `images: z.array(imageOut).optional()` to `images: z.array(imageOut)` in:
  - productTopLevelOut (`/apps/web/src/schemas/product.ts`)
  - recipeOut (`/apps/web/src/schemas/recipe.ts`)
  - combo schemas (`/apps/web/src/schemas/combo.ts`)

- [ ] Change `unitMappings: z.array(unitMappingInput).optional()` to have a default empty array in productInputPayload

- [ ] Update all code that checks for these fields' existence to assume they're always present

### Rationale
This will make the API more predictable and eliminate unnecessary null checks in the frontend code.  