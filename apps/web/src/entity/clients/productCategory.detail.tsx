import { ProductCategoryClassification } from "~/app/finance/spending-classification-review";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const productCategoryDetailHooks = defineDetailHooks("productCategory", {
  slots: {
    "spending-classification": { component: ProductCategoryClassification },
  },
});
