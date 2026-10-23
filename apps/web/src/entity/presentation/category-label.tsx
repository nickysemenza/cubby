import type { ProductCategory } from "@cubby/shared";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useProductCategories } from "~/entity/hooks/use-product-categories";
import { EnumPill } from "~/ui/primitives/enum-pill";
import { NoneValue } from "~/ui/primitives/none-value";
import { Spinner } from "~/ui/primitives/spinner";

import { getCategoryColor } from "./category-theme";
import { CategoryIcon } from "./product-category-icons";

interface CategoryLabelProps {
  category: ProductCategory | null;
}

/** The category's full path as a pill that opens the category. Dense
 * surfaces render this in place of the generic reference link, so the pill
 * itself must stay the link. */
export function CategoryLabel({ category }: CategoryLabelProps) {
  if (!category) return <NoneValue />;

  return (
    <Link
      to="/product-categories/$shortcode"
      params={{ shortcode: category.id }}
      className="group inline-flex max-w-full min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // A clickable row must not also open its own record.
      onClick={(event) => event.stopPropagation()}
    >
      <EnumPill
        color={getCategoryColor(category)}
        icon={<CategoryIcon category={category} />}
        className="transition-colors group-hover:border-current"
      >
        {category.path.map((node) => node.name).join(" / ")}
      </EnumPill>
    </Link>
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
  return (
    <EntityRefLink
      variant="byId"
      entityKind="productCategory"
      entityId={id}
      name={name}
    />
  );
}
