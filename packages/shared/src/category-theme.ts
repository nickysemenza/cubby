/** Compact category projection carried by Product reads. */
export type ProductCategory = {
  id: string;
  name: string;
  path: readonly { id: string; name: string }[];
  feature: string | null;
};

/**
 * Whether an inventory entry is movable stock or a fixed installation.
 *
 * Lives here rather than in @cubby/schemas/inventory because both the inventory
 * schema and the product schema need it, and inventory already imports product
 * — putting it in either one closes a cycle.
 */
export const inventoryPlacementValues = ["stock", "installed"] as const;
export type InventoryPlacement = (typeof inventoryPlacementValues)[number];

const featureColors = {
  food: "var(--chart-1)",
  books: "var(--chart-3)",
  tools: "var(--chart-2)",
  "tool-consumables": "var(--chart-4)",
  "tool-accessories": "var(--chart-6)",
  storage: "var(--chart-3)",
  hardware: "var(--chart-5)",
  electronics: "var(--chart-7)",
  software: "var(--chart-5)",
  apparel: "var(--chart-4)",
  household: "var(--chart-8)",
  supplies: "var(--chart-6)",
} as const satisfies Record<string, string>;

export const getCategoryColor = (
  category: ProductCategory | null | undefined,
): string =>
  Object.entries(featureColors).find(
    ([feature]) => feature === category?.feature,
  )?.[1] ?? "var(--chart-neutral)";

export const formatCategoryLabel = (
  category: ProductCategory | null | undefined,
): string => {
  if (!category) return "Unclassified";
  const path = category.path.map((node) => node.name).filter(Boolean);
  return path.length > 0 ? path.join(" / ") : category.name;
};

export const isNonFoodCategory = (
  category: ProductCategory | null | undefined,
): boolean => category != null && category.feature !== "food";
