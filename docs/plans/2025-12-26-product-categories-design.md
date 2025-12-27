# Product Categories Design

## Overview

Add a category system to products for filtering/organization, with consumability derived from category.

## Schema Changes

### New Zod enum in `apps/web/src/schemas/product.ts`

```typescript
export const productCategory = z.enum([
  "food",             // flour, olive oil, canned tomatoes
  "tools",            // angle grinder, drill, screwdriver
  "tool-consumables", // grinding discs, drill bits, sandpaper
  "hardware",         // screws, nails, bolts
  "electronics",      // raspberry pi, cables, monitors
  "household",        // furniture, cookware, appliances
  "supplies",         // cleaning products, tape, batteries
]);

export type ProductCategory = z.infer<typeof productCategory>;

// Consumability derived from category
const consumableCategories: Set<ProductCategory> = new Set([
  "food",
  "tool-consumables",
  "hardware",
  "supplies",
]);

export const isConsumableCategory = (cat: ProductCategory) =>
  consumableCategories.has(cat);
```

### Product schema update

Add to `productBase`:
```typescript
category: productCategory.nullable(),
```

Nullable so existing products don't break — they can be gradually categorized.

## Database Changes

Add `category` column to `product` table:
- Type: `text` (stores enum value)
- Nullable: yes
- No foreign key (enum values stored directly)

## UI Changes

1. **Product form**: Add select field for category using existing `SelectField` component
2. **Product list**: Add category column, enable filtering by category
3. **Optional**: Show small "consumable" badge derived from category

## CSV Import/Export

Add `category` column to `inventoryCSVRow` schema for bulk import/export.

## What's NOT included

- Location categories (existing `locationType` enum is sufficient)
- Per-product consumability override (derived from category is enough)
- Hierarchical categories (flat list of broad buckets)
- User-defined categories (fixed enum in code)
