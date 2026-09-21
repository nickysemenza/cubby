import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import {
  Archive,
  Bolt,
  BookOpen,
  Cpu,
  Disc,
  type LucideIcon,
  Package,
  Settings,
  Shirt,
  Sofa,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";

// Re-export colors/helpers from @cubby/shared for existing consumers
export { formatCategoryLabel, getCategoryColor };

const featureIcons = {
  food: Utensils,
  tools: Wrench,
  "tool-consumables": Disc,
  "tool-accessories": Settings,
  storage: Archive,
  hardware: Bolt,
  electronics: Cpu,
  software: Package,
  books: BookOpen,
  household: Sofa,
  supplies: Sparkles,
  apparel: Shirt,
} satisfies Record<string, LucideIcon>;

/**
 * Get the icon component for a product category
 */
export const getCategoryIcon = (
  feature: string | null | undefined,
): LucideIcon =>
  Object.entries(featureIcons).find(([key]) => key === feature)?.[1] ?? Package;
