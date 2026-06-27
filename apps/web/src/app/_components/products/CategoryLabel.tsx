import type { ProductCategory } from "@cubby/schemas/product";
import { DotLabel } from "~/components/ui/dot-label";
import { NoneValue } from "~/components/ui/none-value";
import { getCategoryColor } from "./category-theme";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

export function CategoryLabel({ category }: CategoryLabelProps) {
  if (!category) return <NoneValue />;

  return (
    <DotLabel color={getCategoryColor(category)}>
      {category.replace("-", " ")}
    </DotLabel>
  );
}
