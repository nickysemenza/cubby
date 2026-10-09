import { mealListSlots } from "~/app/meals/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const mealListHooks = defineListHooks("meal", {
  slots: mealListSlots,
});
