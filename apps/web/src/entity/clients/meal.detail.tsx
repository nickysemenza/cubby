import { MealActions, MealComposition, MealNutrition } from "~/app/meals/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const mealDetailHooks = defineDetailHooks("meal", {
  slots: {
    composition: { component: MealComposition },
    nutrition: { component: MealNutrition },
  },
  headerActions: MealActions,
});
