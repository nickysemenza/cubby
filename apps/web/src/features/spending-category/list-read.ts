import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const spendingCategoryListReadProjection = specialistListReadProjection({
  nesting: "flat",
  always: ["parentId", "productCategories"],
});
