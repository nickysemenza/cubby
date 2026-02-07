import {
  formatCategoryLabel,
  getCategoryColor,
  type ProductCategory,
} from "@cubby/shared";
import { Pill } from "./Pill";

interface CategoryBadgeProps {
  category: ProductCategory | null;
}

export function CategoryBadge({ category }: CategoryBadgeProps) {
  return (
    <Pill
      label={formatCategoryLabel(category)}
      color={getCategoryColor(category)}
    />
  );
}
