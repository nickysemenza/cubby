import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const spendingCategoryListReadProjection = specialistListReadProjection({
  always: ["parentId", "productCategories"],
});
