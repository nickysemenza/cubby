import {
  Archive,
  Bolt,
  Cpu,
  Disc,
  type LucideIcon,
  Settings,
  Sofa,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";
import { assertNever } from "~/lib/assert";
import type { ProductCategory } from "~/schemas/product";

/**
 * Product category color groups - color families with within-group variation
 * Groups provide visual recognition, variations provide individual distinction
 */
type CategoryGroup =
  | "food"
  | "tools"
  | "organization"
  | "building"
  | "tech"
  | "home";

const categoryToGroup: Record<ProductCategory, CategoryGroup> = {
  food: "food",
  tools: "tools",
  "tool-consumables": "tools",
  "tool-accessories": "tools",
  storage: "organization",
  hardware: "building",
  electronics: "tech",
  household: "home",
  supplies: "home",
};

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
 * Get the group for a product category (useful for logic based on grouping)
 */
export const getCategoryGroup = (category: ProductCategory): CategoryGroup =>
  categoryToGroup[category];

/**
 * Format a category value for display
 */
export const formatCategoryLabel = (
  category: ProductCategory | null,
): string => (category ? category.replace("-", " ") : "uncategorized");

/**
 * Get the icon component for a product category
 */
export const getCategoryIcon = (category: ProductCategory): LucideIcon => {
  switch (category) {
    case "food":
      return Utensils;
    case "tools":
      return Wrench;
    case "tool-consumables":
      return Disc;
    case "tool-accessories":
      return Settings;
    case "storage":
      return Archive;
    case "hardware":
      return Bolt;
    case "electronics":
      return Cpu;
    case "household":
      return Sofa;
    case "supplies":
      return Sparkles;
    default:
      assertNever(category);
  }
};
