import type { ProductCategory } from "@cubby/shared";
import { Link } from "@tanstack/react-router";

import { EnumPill } from "~/ui/primitives/enum-pill";
import { NoneValue } from "~/ui/primitives/none-value";

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
