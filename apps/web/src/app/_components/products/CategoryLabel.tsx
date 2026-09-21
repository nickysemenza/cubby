import type { ProductCategory } from "@cubby/shared";

import { EnumPill } from "~/components/ui/enum-pill";
import { NoneValue } from "~/components/ui/none-value";

import { getCategoryColor } from "./category-theme";
import { CategoryIcon } from "./product-category-icons";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

export function CategoryLabel({ category }: CategoryLabelProps) {
  if (!category) return <NoneValue />;

  return (
    <EnumPill
      color={getCategoryColor(category)}
      icon={<CategoryIcon category={category} />}
    >
      {category.path.map((node) => node.name).join(" / ")}
    </EnumPill>
  );
}
