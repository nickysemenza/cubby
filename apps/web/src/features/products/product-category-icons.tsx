import type { ProductCategory } from "@cubby/shared";

import { getCategoryColor, getCategoryIcon } from "./category-theme";

interface CategoryIconProps {
  category: ProductCategory;
  className?: string;
  size?: number;
  /** Apply the category's specific color */
  colored?: boolean;
}

export function CategoryIcon({
  category,
  className,
  size = 16,
  colored,
}: CategoryIconProps) {
  const IconComponent = getCategoryIcon(category.feature);
  return (
    <IconComponent
      className={className}
      size={size}
      style={colored ? { color: getCategoryColor(category) } : undefined}
    />
  );
}
