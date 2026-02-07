// Product category values - single source of truth for both Zod and Drizzle
export const productCategoryValues = [
  "food", // flour, olive oil, canned tomatoes
  "tools", // angle grinder, drill, screwdriver, hand tools
  "tool-consumables", // grinding discs, drill bits, sandpaper
  "tool-accessories", // jigs, fixtures, router table accessories
  "storage", // packout, systainers, toolboxes, bags
  "hardware", // screws, nails, bolts
  "electronics", // raspberry pi, cables, monitors
  "household", // furniture, cookware, appliances
  "supplies", // cleaning products, tape, batteries, cables
] as const;

export type ProductCategory = (typeof productCategoryValues)[number];

/**
 * Color palette for product categories - color families with variations
 * Each group has a base hue, items vary by lightness/saturation
 */
export const categoryColors: Record<ProductCategory | "uncategorized", string> =
  {
    // Food group (green)
    food: "hsl(142, 55%, 45%)",

    // Tools group (blue family)
    tools: "hsl(220, 55%, 45%)", // base (darker)
    "tool-consumables": "hsl(220, 55%, 55%)", // lighter
    "tool-accessories": "hsl(220, 45%, 40%)", // muted/darker

    // Organization group (orange)
    storage: "hsl(35, 55%, 50%)",

    // Building group (red)
    hardware: "hsl(0, 55%, 50%)",

    // Tech group (purple)
    electronics: "hsl(280, 55%, 50%)",

    // Home group (teal family)
    household: "hsl(180, 45%, 45%)", // base
    supplies: "hsl(180, 55%, 55%)", // lighter/brighter

    // Fallback
    uncategorized: "hsl(0, 0%, 65%)",
  };

/**
 * Get the color for a product category
 */
export const getCategoryColor = (category: ProductCategory | null): string =>
  category ? categoryColors[category] : categoryColors.uncategorized;

/**
 * Format a category value for display
 */
export const formatCategoryLabel = (
  category: ProductCategory | null,
): string => (category ? category.replace("-", " ") : "uncategorized");
