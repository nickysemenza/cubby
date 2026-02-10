import {
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
export { formatCategoryLabel, getCategoryColor };

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
