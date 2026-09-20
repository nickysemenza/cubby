import type { ProductCategory } from "@cubby/schemas/product";

import { EnumPill } from "~/components/ui/enum-pill";
import { NoneValue } from "~/components/ui/none-value";

import { getCategoryColor } from "./category-theme";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

export function CategoryLabel({ category }: CategoryLabelProps) {
  if (!category) return <NoneValue />;

  return (
    <EnumPill color={getCategoryColor(category)}>
      {category.replace("-", " ")}
    </EnumPill>
  );
}
