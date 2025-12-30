import { cn } from "~/lib/utils";
import { type ProductCategory, productCategory } from "~/schemas/product";
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

interface CategoryIconWithLabelProps extends CategoryIconProps {
  label?: string;
  showLabel?: boolean;
}

export function CategoryIconWithLabel({
  category,
  label,
  className,
  size = 16,
  showLabel = true,
  colored,
}: CategoryIconWithLabelProps) {
  const displayLabel = label ?? category.replace("-", " ");
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <CategoryIcon category={category} size={size} colored={colored} />
      {showLabel && <span>{displayLabel}</span>}
    </div>
  );
}

/** Product category options with colored icons for dropdowns */
export const productCategoryOptionsWithTheme = productCategory.options.map(
  (cat) => ({
    value: cat,
    label: cat.replace("-", " "),
    icon: <CategoryIcon category={cat} size={14} colored />,
    color: getCategoryColor(cat),
  }),
);
