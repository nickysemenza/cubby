export const productCategoryValues = [
  "food", // flour, olive oil, canned tomatoes
  "tools", // angle grinder, drill, screwdriver, hand tools
  "tool-consumables", // grinding discs, drill bits, sandpaper
  "tool-accessories", // jigs, fixtures, router table accessories
  "storage", // packout, systainers, toolboxes, bags
  "hardware", // screws, nails, bolts
  "electronics", // raspberry pi, cables, monitors
  "software", // subscriptions and software licenses
  "household", // furniture, cookware, appliances
  "supplies", // cleaning products, tape, batteries, cables
] as const;

export type ProductCategory = (typeof productCategoryValues)[number];

/**
 * Whether an inventory entry is movable stock or a fixed installation.
 *
 * Lives here rather than in @cubby/schemas/inventory because both the inventory
 * schema and the product schema need it, and inventory already imports product
 * — putting it in either one closes a cycle.
 */
export const inventoryPlacementValues = ["stock", "installed"] as const;
export type InventoryPlacement = (typeof inventoryPlacementValues)[number];

/**
 * The only food category. Everything else (tools, hardware, household, …) is a
 * non-food household/garage item that has no meaning for recipe costing —
 * weight/volume/price/calorie unit coverage doesn't apply. A `null`/unset
 * category is treated as *potentially* food (not excluded) so uncategorized
 * grocery items keep their coverage grading.
 */
export const FOOD_CATEGORY: ProductCategory = "food";

/**
 * Whether a product's category is a non-food one (garage/household gear). Used
 * to exempt these products from food-only concerns: the unit-coverage Problems
 * detectors and the product-detail coverage UI (calories chip, USDA nudge).
 * A `null`/undefined category is NOT non-food — it stays eligible.
 *
 * Single source of truth for the food/non-food split; import this rather than
 * re-listing categories.
 */
export const isNonFoodCategory = (
  category: ProductCategory | null | undefined,
): boolean => category != null && category !== FOOD_CATEGORY;

/**
 * Color palette for product categories — Warm-Paper Ledger (2026-06-25).
 * Pulls from the app's retoned categorical chart ramp: a monochrome ink ladder
 * (chart-2..8, dark→light) with the lone ultramarine (chart-1) reserved for the
 * dominant "food" category. Matte, off the warm axis — distinguishes categories
 * by value, not hue, so category dots/donut segments read as one printed figure.
 */
export const categoryColors: Record<ProductCategory | "uncategorized", string> =
  {
    food: "var(--chart-1)",

    tools: "var(--chart-2)",
    "tool-consumables": "var(--chart-4)",
    "tool-accessories": "var(--chart-6)",

    storage: "var(--chart-3)",

    hardware: "var(--chart-5)",

    electronics: "var(--chart-7)",
    software: "var(--chart-5)",

    household: "var(--chart-8)",
    supplies: "var(--chart-6)",

    uncategorized: "var(--chart-neutral)",
  };

export const getCategoryColor = (category: ProductCategory | null): string =>
  category ? categoryColors[category] : categoryColors.uncategorized;

export const formatCategoryLabel = (
  category: ProductCategory | null,
): string => (category ? category.replace("-", " ") : "uncategorized");
