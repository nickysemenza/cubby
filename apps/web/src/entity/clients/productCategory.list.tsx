import { productCategoryListSlots } from "~/app/product-categories/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const productCategoryListHooks = defineListHooks("productCategory", {
  slots: productCategoryListSlots,
});
