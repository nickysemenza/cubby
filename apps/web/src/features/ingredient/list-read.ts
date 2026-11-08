import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const ingredientListReadProjection = specialistListReadProjection({
  always: ["productSummaries"],
  whenShown: { appearsInRecipes: ["appearsInRecipes"] },
});
