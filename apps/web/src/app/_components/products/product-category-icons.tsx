import { type ProductCategory, productCategory } from "@cubby/schemas/product";

import { getCategoryColor, getCategoryIcon } from "./category-theme";

interface CategoryIconProps {
  category: ProductCategory;
  className?: string;
  size?: number;
  /** Apply the category's specific color */
  colored?: boolean;
}

function CategoryIcon({
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
 * Product category options with colored icons for dropdowns.
 *
 * No `color`: the combobox renders that as a swatch *beside* the icon, and the
 * icon is already tinted with the same value — two marks for one fact.
 */
export const productCategoryOptionsWithTheme = productCategory.options.map(
  (cat) => ({
    value: cat,
    label: cat.replace("-", " "),
    icon: <CategoryIcon category={cat} size={14} colored />,
  }),
);
