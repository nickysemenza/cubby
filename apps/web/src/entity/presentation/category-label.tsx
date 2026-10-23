import type { ProductCategory } from "@cubby/shared";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useProductCategories } from "~/entity/hooks/use-product-categories";
import { NoneValue } from "~/ui/primitives/none-value";
import { Spinner } from "~/ui/primitives/spinner";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

/** A category supplies its full-path label to the shared record identity. */
export function CategoryLabel({ category }: CategoryLabelProps) {
  if (!category) return <NoneValue />;
  return (
    <EntityRefLink
      entity="productCategory"
      id={category.id}
      name={category.path.map((node) => node.name).join(" / ")}
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
  if (category)
    return (
      <CategoryLabel
        category={{ ...category, feature: category.effectiveFeature }}
      />
    );
  if (!error && (isLoading || !isComplete)) {
    if (name) return <span className="min-w-0 truncate">{name}</span>;
    return <Spinner className="size-3" aria-label="Loading category" />;
  }
  // A deleted category or a failed vocabulary read keeps its record link.
  return <EntityRefLink entity="productCategory" id={id} name={name} />;
}
