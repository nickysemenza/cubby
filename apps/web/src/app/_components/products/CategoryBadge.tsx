import type { ProductCategory } from "@cubby/schemas/product";
import { NoneState } from "~/app/_components/NoneState";
import { Pill } from "~/app/_components/Pill";
import { getCategoryColor } from "./category-theme";
import { CategoryIcon } from "./product-category-icons";

interface CategoryBadgeProps {
  category: ProductCategory | null;
}

export function CategoryBadge({ category }: CategoryBadgeProps) {
  if (!category) return <NoneState />;

  return (
    <Pill
      icon={<CategoryIcon category={category} size={12} colored />}
      color={getCategoryColor(category)}
    >
      {category.replace("-", " ")}
    </Pill>
  );
}
