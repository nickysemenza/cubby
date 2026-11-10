import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ProductCategorySummary as ProductCategory } from "@cubby/schemas/product-category-fields";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { RecordEmoji, recordEmojiOf } from "~/entity/components/record-emoji";
import { useProductCategories } from "~/entity/hooks/use-product-categories";
import { Spinner } from "~/ui/primitives/spinner";
import { NoneValue } from "~/ui/text/none-value";

import { categoryLeafParts } from "./category-text";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

/**
 * A category pill leads with its leaf and follows with the muted ancestors;
 * the link's accessible name stays the full root-to-leaf path.
 */
export function CategoryLabel({ category }: CategoryLabelProps) {
  // Embedded summaries carry no mark fields; the shared vocabulary does.
  const { categories } = useProductCategories();
  if (!category) return <NoneValue />;
  const { leaf, parent } = categoryLeafParts(
    (fieldValueOf(category.fields.path) ?? []).map((node) => node.name),
    category.name,
  );
  const marked = categories.find((row) => row.id === category.id) ?? category;
  return (
    <EntityRefLink
      entity="productCategory"
      id={category.id}
      name={leaf}
      parent={parent}
      emoji={recordEmojiOf("productCategory", marked)}
      fallback={
        <RecordEmoji entity="productCategory" record={marked} size={12} />
      }
    />
  );
}

/**
 * A stored category reference (a proposed value carries only the code) as
 * its full-path pill, resolved through the shared category vocabulary.
 * A known `name` stands in while the vocabulary loads or when it cannot be read.
 */
export function CategoryLabelById({
  id,
  name,
}: {
  id: string;
  name?: string | null;
}) {
  const { categories, isLoading, isComplete, error } = useProductCategories();
  const category = categories.find((row) => row.id === id);
  if (category) return <CategoryLabel category={category} />;
  if (!error && (isLoading || !isComplete)) {
    if (name) return <span className="min-w-0 truncate">{name}</span>;
    return <Spinner className="size-3" aria-label="Loading category" />;
  }
  // A deleted category or a failed vocabulary read keeps its record link.
  return <EntityRefLink entity="productCategory" id={id} name={name} />;
}
