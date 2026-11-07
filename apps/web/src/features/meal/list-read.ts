import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const mealListReadProjection = specialistListReadProjection({
  always: ["date", "name"],
});
