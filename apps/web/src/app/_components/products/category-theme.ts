import {
  categoryColors,
  formatCategoryLabel,
  getCategoryColor,
  type ProductCategory,
} from "@cubby/shared";
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

// Re-export colors/helpers from @cubby/shared for existing consumers
export { categoryColors, formatCategoryLabel, getCategoryColor };

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
 * Get the group for a product category (useful for logic based on grouping)
 */
export const getCategoryGroup = (category: ProductCategory): CategoryGroup =>
  categoryToGroup[category];

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
