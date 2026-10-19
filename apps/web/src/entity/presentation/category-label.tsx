import type { ProductCategory } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
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

// The list's own sibling order; the server nests every level. Shared with
// the category hierarchy so both read one cached tree.
export const CATEGORY_TREE_INPUT = compileEntityListInput(
  "productCategory",
  {},
  { defaultSort: { orderBy: "sortOrder", direction: "asc" } },
);

type CategoryTreeRow = {
  id: string;
  name: string;
  feature: string | null;
  subRows?: CategoryTreeRow[];
};

/** The category with its full path and nearest feature, found in the tree. */
function findCategory(
  rows: readonly CategoryTreeRow[],
  id: string,
  path: { id: string; name: string }[] = [],
  feature: string | null = null,
): ProductCategory | null {
  for (const row of rows) {
    const here = [...path, { id: row.id, name: row.name }];
    const inherited = row.feature ?? feature;
    if (row.id === id)
      return { id: row.id, name: row.name, path: here, feature: inherited };
    const nested = row.subRows
      ? findCategory(row.subRows, id, here, inherited)
      : null;
    if (nested) return nested;
  }
  return null;
}

/**
 * A stored category reference (a proposed value carries only the code) as
 * its full-path pill, resolved through the server-nested category tree.
 * A known `name` stands in while the tree loads or when it cannot be read.
 */
export function CategoryLabelById({
  id,
  name,
}: {
  id: string;
  name?: string | null;
}) {
  const { tree, isLoading, error } = useServerTree(
    "productCategory",
    CATEGORY_TREE_INPUT,
  );
  const category = useMemo(
    () => (tree ? findCategory(tree, id) : null),
    [tree, id],
  );
  if (category) return <CategoryLabel category={category} />;
  if (name && !error && (isLoading || !tree))
    return <span className="min-w-0 truncate">{name}</span>;
  if (isLoading || (!tree && !error))
    return <Spinner className="size-3" aria-label="Loading category" />;
  // A deleted category or a failed tree read keeps its record link.
  return (
    <EntityRefLink
      variant="byId"
      entityKind="productCategory"
      entityId={id}
      name={name}
    />
  );
}
