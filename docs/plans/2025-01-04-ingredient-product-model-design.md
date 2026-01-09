# Ingredient-Product Model Design (Reference Doc)

**Status:** Design clarification only - no implementation needed yet

## Context

Ingredients are the stable abstraction that recipes reference. Products underneath can be configured flexibly (generic, specific, or any mix). Rather than picking a single "default" product, we aggregate across all linked products for pricing and unit conversions.

## Key Design Decisions

1. **Ingredients can exist without products** - Valid but incomplete state (no costing/conversions until products linked)
2. **No `defaultProductId` needed** - Aggregate across all linked products instead
3. **Pricing:** min/max/avg across linked products (excludes `misc:` products since they're opaque placeholders)
4. **Unit conversions:** Simple average when mappings conflict (same unit pair, e.g., "1 cup = 240g" and "1 cup = 250g" → average to "1 cup = 245g")
5. **Nutrition:** USDA generic data on ingredient (future via name matching), or avg products if no USDA

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
- Filter out `misc:` products from pricing calculations (they're just placeholders)

### Unit Mapping Averaging
- When needed, add `averageUnitMappings()` helper in `schemas/unit-mapping-utils.ts`
- Group by unit pair (e.g., "cup → g"), average values, filter outliers if needed
- Example: Product A "1 cup = 240g" + Product B "1 cup = 250g" → "1 cup = 245g"
- Note: Not currently needed since we use all product mappings together (WASM handles conflicts)

### Ingredients Without Products
- Add `findIngredientsWithoutProducts()` in `problems.ts`
- Follow pattern of existing `findOrphanedProducts()`
- UI: Show warning badge, disable cost display, or show "Configure products to see pricing"

### USDA Integration (Future)
- Match ingredient name to USDA entries for nutrition data
- Fallback to averaging product nutrition if no USDA match found
