import type { ProductCategory } from "@cubby/schemas/product";
import { DotLabel } from "~/app/_components/DotLabel";
import { NoneState } from "~/app/_components/NoneState";
import { getCategoryColor } from "./category-theme";

interface CategoryBadgeProps {
  category: ProductCategory | null;
}

export function CategoryBadge({ category }: CategoryBadgeProps) {
  if (!category) return <NoneState />;

  return (
    <DotLabel color={getCategoryColor(category)}>
      {category.replace("-", " ")}
    </DotLabel>
  );
}
