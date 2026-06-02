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
 * Color palette for product categories - warm-anchored families with variations.
 * Each group keeps a distinct earthy hue; items vary by lightness/chroma.
 * Tuned to harmonize with the app's warm palette (no cold blue/teal/purple).
 */
export const categoryColors: Record<ProductCategory | "uncategorized", string> =
  {
    // Food group (warm green)
    food: "oklch(0.58 0.09 140)",

    // Tools group (earthy clay/brown family)
    tools: "oklch(0.5 0.07 50)", // base (darker)
    "tool-consumables": "oklch(0.62 0.07 55)", // lighter
    "tool-accessories": "oklch(0.44 0.05 58)", // muted/darker

    // Organization group (honey/amber)
    storage: "oklch(0.7 0.12 70)",

    // Building group (warm brick-red)
    hardware: "oklch(0.6 0.13 8)",

    // Tech group (warm plum)
    electronics: "oklch(0.5 0.13 345)",

    // Home group (muted warm teal family)
    household: "oklch(0.6 0.06 198)", // base
    supplies: "oklch(0.68 0.07 196)", // lighter/brighter

    // Fallback (warm grey)
    uncategorized: "oklch(0.7 0.02 70)",
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
