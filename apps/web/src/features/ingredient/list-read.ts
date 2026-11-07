import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const ingredientListReadProjection = specialistListReadProjection({
  always: ["product"],
  whenShown: { appearsInRecipes: ["appearsInRecipes"] },
});
