import {
  IngredientNutritionProduct,
  IngredientRecipeUsages,
} from "~/app/ingredients/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const ingredientDetailHooks = defineDetailHooks("ingredient", {
  slots: {
    "nutrition-product": { component: IngredientNutritionProduct },
    "recipe-usages": { component: IngredientRecipeUsages },
  },
});
