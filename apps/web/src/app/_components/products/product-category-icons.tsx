import { type ProductCategory, productCategory } from "@cubby/schemas/product";

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
  const IconComponent = getCategoryIcon(category);
  return (
    <IconComponent
      className={className}
      size={size}
      style={colored ? { color: getCategoryColor(category) } : undefined}
    />
  );
}

/**
 * Product category options with colored icons for dropdowns. The shared static
 * picker suppresses its fallback swatch when an option already has an icon, so
 * each row carries exactly one categorical mark.
 */
export const productCategoryOptionsWithTheme = productCategory.options.map(
  (cat) => ({
    value: cat,
    label: cat.replace("-", " "),
    icon: <CategoryIcon category={cat} size={14} colored />,
  }),
);
