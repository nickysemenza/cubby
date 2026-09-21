import { NoneValue } from "~/components/ui/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const productCategoryDetailFields = {
  "product-category-path": (category) => ({
    value:
      category.path.length > 0 ? (
        category.path.map((node) => node.name).join(" / ")
      ) : (
        <NoneValue />
      ),
  }),
} satisfies EntityDetailFieldRenderers<"productCategory">;
