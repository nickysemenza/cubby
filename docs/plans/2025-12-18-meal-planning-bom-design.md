# Meal Planning & BOM Production Design

## Overview

Add meal planning, recipe costing, shopping list generation, and inventory consumption for home use. Builds on existing recipe costing infrastructure (`calculateTotals`, WASM unit conversions).

## Goals

1. **Recipe costing** - Show cost per recipe and per serving (already partially implemented)
2. **Production planning** - Scale recipes by multiplier or target yield
3. **Inventory consumption** - Deduct ingredients from inventory when cooking
4. **Shopping list** - Generate list of what to buy based on planned meals
5. **Meal suggestions** - "What can I make with what I have?"

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Price source | Derived from product unit mappings | Leverage existing WASM conversion; no separate price field to maintain |
| Price granularity | Ingredient-level (commingled) | Home use doesn't need per-product cost tracking |
| Inventory consumption | Approximate (any product, any location) | Home kitchen model - don't care which specific bag of flour |
| Meal structure | Unnamed groupings per day | Simple; can add labels (breakfast/lunch/dinner) later |
| Recipe scaling | Both multiplier and yield-based | "2x" or "make 24 cookies" depending on context |

## Data Model

### Schema Changes

**Recipe additions:**
```sql
ALTER TABLE "Recipe" ADD COLUMN yield JSONB;
-- e.g., { "value": 12, "unit": "cookies" } or { "value": 4, "unit": "servings" }
```

**New tables:**
```sql
CREATE TABLE "Meal" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL REFERENCES organization(id),
  date DATE NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP,
  UNIQUE("organizationId", date, id)
);

CREATE TABLE "MealRecipe" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "mealId" UUID NOT NULL REFERENCES "Meal"(id),
  "recipeId" UUID NOT NULL REFERENCES "Recipe"(id),
  scale DECIMAL NOT NULL DEFAULT 1.0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP
);

CREATE INDEX "Meal_organizationId_date_idx" ON "Meal"("organizationId", date);
CREATE INDEX "MealRecipe_mealId_idx" ON "MealRecipe"("mealId");
CREATE INDEX "MealRecipe_recipeId_idx" ON "MealRecipe"("recipeId");
```

### Entity Relationships

```
Organization
  └── Meal (date)
        └── MealRecipe (scale)
              └── Recipe (yield)
                    └── Section
                          └── Ingredient (amounts)
                                └── Product
                                      └── UnitMappings (price)
                                            └── InventoryEntry (quantity @ location)
```

## Existing Infrastructure (No Changes Needed)

- **Recipe costing**: `calculateTotals()` in `univ-conversion.ts` already computes total price, weight, nutrients
- **Unit conversions**: WASM engine handles chained conversions (cups → grams → dollars)
- **Product unit mappings**: Already support price via `1 each = $X` style mappings
- **Inventory tracking**: `InventoryEntry` tracks product quantities at locations

## Workflows

### 1. Plan a Meal

```
User flow:
  Calendar view → Click day → "Add Meal" → Select recipe(s) → Set scale

Data flow:
  1. Create Meal record for date (if none exists)
  2. Create MealRecipe with recipeId and scale
  3. Display in calendar cell
```

### 2. View Recipe Cost

```
Existing flow (enhanced):
  Recipe detail page shows:
    - Per-ingredient cost (already implemented)
    - Total recipe cost (already implemented)
    - NEW: Cost per serving (totalCost / yield)
    - NEW: Scaled cost when scale != 1
```

### 3. Generate Shopping List

```
User flow:
  /meals/shopping-list → Select date range → View aggregated needs

Algorithm:
  1. Get all MealRecipes in date range
  2. For each recipe (scaled):
     - Get all ingredients with amounts × scale
  3. Aggregate by ingredient (sum amounts for same ingredient)
  4. For each ingredient:
     - Find linked products
     - Sum available inventory across all locations
     - Convert to common unit via WASM
     - shortage = needed - available
  5. Return shortages as shopping list

Output:
  | Ingredient | Need | Have | Buy |
  |------------|------|------|-----|
  | Flour      | 4 cups | 1.5 cups | 2.5 cups |
  | Butter     | 2 sticks | 4 sticks | - |
```

### 4. Cook / Consume Inventory

```
User flow:
  Meal detail → "Mark as cooked" → Confirm

Algorithm:
  For each ingredient in meal (with scaled amounts):
    1. Find all products linked to ingredient
    2. Find all inventory entries for those products
    3. Convert recipe amount to inventory unit (WASM)
    4. Deduct from entries until fulfilled:
       - Deduct from first available entry
       - If entry hits zero, delete it
       - Continue to next entry if more needed
    5. Log consumption in audit trail

Edge cases:
  - No inventory: Log "consumed X (none in stock)"
  - Partial inventory: Deduct what's there, log shortfall
  - Unit conversion fails: Skip deduction, log warning
```

### 5. "What Can I Make?"

```
User flow:
  /meals/suggestions OR filter on /recipes

Algorithm:
  For each recipe:
    1. Get all ingredients
    2. For each ingredient:
       - Find linked products
       - Check if any inventory exists
       - Convert to recipe unit, compare to needed amount
    3. Calculate coverage: available_ingredients / total_ingredients
    4. Categorize:
       - "Ready" (100%)
       - "Almost ready" (80-99%, show missing)
       - "Missing X ingredients" (<80%)

UI:
  - Recipe cards with availability badge
  - Filter: "Can make now" / "Missing 1-2" / "All"
  - "Add missing to shopping list" button
```

### 6. "Add to Meal" Shortcut

```
User flow:
  Recipe detail page → [Add to Meal ▼] → Today / Tomorrow / Pick date

Implementation:
  1. Show dropdown with quick options
  2. On select: create Meal (if needed) + MealRecipe at 1x scale
  3. Toast: "Added to Monday's meals"
```

## New Pages

| Route | Purpose |
|-------|---------|
| `/meals` | Calendar view (week grid), click day to see/edit |
| `/meals/[date]` | Day detail: list meals, add/remove recipes, mark cooked |
| `/meals/shopping-list` | Date range picker + aggregated shortage list |
| `/meals/suggestions` | "What can I make?" with availability filtering |

## Recipe Detail Enhancements

- Add `yield` field to recipe form (amount + unit picker)
- Show "Cost per serving" when yield is set
- Add "Add to Meal" dropdown button
- Show scaled costs when viewing from meal context

## API Endpoints (tRPC)

```typescript
// New router: meal
meal.list          // Get meals in date range
meal.getByDate     // Get single day's meals
meal.create        // Create meal for date
meal.delete        // Remove meal

meal.addRecipe     // Add recipe to meal with scale
meal.updateRecipe  // Change scale
meal.removeRecipe  // Remove recipe from meal

meal.markCooked    // Trigger inventory consumption
meal.getShoppingList // Aggregate needs for date range

// New router: suggestions
suggestions.getRecipeAvailability  // Coverage % for recipes
suggestions.getMakeable            // Filtered list of makeable recipes
```

## Out of Scope (v1)

- Price history tracking
- Location preferences for consumption (e.g., "kitchen first")
- Meal labels (breakfast/lunch/dinner)
- Recurring meals ("tacos every Tuesday")
- Partial cooking (cook whole meal or nothing)
- Multi-user meal views (organization-scoped only)
- Grocery store aisle mapping
- Low stock indicators (separate feature)
- Expiration date tracking (separate feature)

## Future Enhancements (v2)

- **Meal suggestions based on expiring items** - "Use this before it expires"
- **Smart consumption order** - FEFO (first expired, first out)
- **Meal templates** - Save common meal combinations
- **Nutrition goals** - "This week's meals: 12,000 calories, $85"
- **Recipe scaling UI** - Slider or "I want X servings" input

## Technical Notes

### WASM Integration

Shopping list and consumption both need unit conversion:
```typescript
import { convertAmount } from "~/lib/wasm";

// Convert recipe amount to inventory unit
const inventoryAmount = await convertAmount(
  recipeAmount,      // { value: 2, unit: "cups" }
  inventoryUnit,     // "grams"
  productMappings    // from getAllUnitMappingsFromProduct
);
```

### Audit Logging

Consumption should create audit entries:
```typescript
await createAuditLog({
  entityType: "inventory",
  entityId: inventoryEntry.id,
  action: "update",
  changes: { amount: { from: oldAmount, to: newAmount } },
  source: "meal_consumption",
});
```

### Transaction Safety

Consumption must be atomic:
```typescript
await withTransaction(db, async (tx) => {
  for (const deduction of deductions) {
    if (deduction.newAmount <= 0) {
      await deleteInventoryEntry(tx, deduction.entryId);
    } else {
      await updateInventoryEntry(tx, deduction.entryId, deduction.newAmount);
    }
  }
  await markMealAsCooked(tx, mealId);
});
```
