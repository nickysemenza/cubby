import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";

import { CategoryLabelById } from "./category-label";
import { SpendingCategoryLabel } from "./spending-category-label";

/**
 * A category reference as its declared pill, for surfaces that name records
 * of any kind (audit values, AI usage). Other kinds return `null` so the
 * caller keeps its own record link.
 */
export function categoryReference(
  entity: Entity,
  id: string,
  name?: string | null,
): ReactNode {
  if (entity === "productCategory")
    return <CategoryLabelById id={id} name={name} />;
  if (entity === "spendingCategory")
    return <SpendingCategoryLabel id={id} name={name} />;
  return null;
}
