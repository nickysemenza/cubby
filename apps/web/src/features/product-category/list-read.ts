import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const productCategoryListReadProjection = specialistListReadProjection({
  always: ["spendingCategoryMapping", "parentId", "productCount"],
});
