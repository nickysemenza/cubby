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

/** A compact pill's label: the leaf, then its ancestors joined root first. */
export type CategoryLeafParts = { leaf: string; parent: string | null };

/** Split a root-to-leaf path so compact pills can lead with the leaf. */
export const categoryLeafParts = (
  path: readonly string[],
  fallback: string,
): CategoryLeafParts => {
  const names = path.filter(Boolean);
  const leaf = names.at(-1) ?? fallback;
  return {
    leaf,
    parent: names.length > 1 ? names.slice(0, -1).join(" / ") : null,
  };
};
