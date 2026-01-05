# Ingredient-Product Model Design (Reference Doc)

**Status:** Design clarification only - no implementation needed yet

## Context

Ingredients are the stable abstraction that recipes reference. Products underneath can be configured flexibly (generic, specific, or any mix). Rather than picking a single "default" product, we aggregate across all linked products for pricing and unit conversions.

## Key Design Decisions

1. **Ingredients can exist without products** - Valid but incomplete state (no costing/conversions until products linked)
2. **No `defaultProductId` needed** - Aggregate across all linked products instead
3. **Pricing:** min/max/avg across linked products
4. **Unit conversions:** Simple average when mappings conflict
5. **Nutrition:** USDA generic data on ingredient (future), or avg products if no USDA

## When to Implement

Trigger implementation when:
- Recipe import becomes awkward due to product requirements
- Recipe costing is inaccurate due to wrong/missing defaults
- Users frequently have multiple products per ingredient with different prices

---

## Implementation Notes (For Future Reference)

### Aggregated Pricing
- Update `calculateTotals()` in `univ-conversion.tsx` to return `{ avg, min, max, productCount }`
- Update `RecipeSummaryCard` in `RecipeDetail.tsx` to show "~$X ($Y - $Z)"

### Unit Mapping Averaging
- Add `averageUnitMappings()` helper in `unit-mapping-utils.ts`
- Group by unit pair, average values before passing to WASM

### Problems Page
- Add `findIngredientsWithoutProducts()` in `problems.ts`
- Follow pattern of existing `findOrphanedProducts()`
