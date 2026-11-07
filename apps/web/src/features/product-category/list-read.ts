import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const productCategoryListReadProjection = specialistListReadProjection({
  nesting: "flat",
  always: ["spendingCategoryMapping", "parentId", "productCount"],
});
