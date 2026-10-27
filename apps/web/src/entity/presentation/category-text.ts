import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ProductCategorySummary } from "@cubby/schemas/product-category-fields";
import { formatCategoryLabel } from "@cubby/shared";

export const categoryText = (
  category: ProductCategorySummary | null | undefined,
): string =>
  formatCategoryLabel(
    category
      ? { ...category, path: fieldValueOf(category.fields.path) ?? [] }
      : null,
  );
