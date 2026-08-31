import {
  formatCategoryLabel,
  getCategoryColor,
  type ProductCategory,
} from "@cubby/shared";
import {
  AppWindow,
  Archive,
  Bolt,
  BookOpen,
  Cpu,
  Disc,
  type LucideIcon,
  Settings,
  Shirt,
  Sofa,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";

// Re-export colors/helpers from @cubby/shared for existing consumers
export { formatCategoryLabel, getCategoryColor };

// Exhaustive at construction: a new ProductCategory without a key here is a
// compile error (replaces the old assertNever default-case guarantee).
const categoryIcons = {
  food: Utensils,
  tools: Wrench,
  "tool-consumables": Disc,
  "tool-accessories": Settings,
  storage: Archive,
  hardware: Bolt,
  electronics: Cpu,
  software: AppWindow,
  books: BookOpen,
  household: Sofa,
  supplies: Sparkles,
  apparel: Shirt,
} satisfies Record<ProductCategory, LucideIcon>;

/**
 * Get the icon component for a product category
 */
export const getCategoryIcon = (category: ProductCategory): LucideIcon =>
  categoryIcons[category]; // safe: complete Record keyed by the enum
