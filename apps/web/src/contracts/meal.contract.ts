import * as schemas from "@cubby/schemas/meal";

import { defineContract, mutation, query } from "~/contracts/define";

export const mealContract = defineContract("meal", {
  getNutrition: query({
    input: schemas.mealNutritionInput,
    output: schemas.mealNutritionOut,
  }),
  saveFood: mutation({
    input: schemas.saveMealFoodInput,
    output: schemas.mealFoodMutationOut,
  }),
  removeFood: mutation({
    input: schemas.removeMealFoodInput,
    output: schemas.mealFoodMutationOut,
  }),
  getByDateRange: query({
    input: schemas.mealDateRange,
    output: schemas.mealListOut,
  }),
  upcomingSummary: query({
    input: schemas.mealDateRange,
    output: schemas.upcomingMealSummaryOut,
  }),
  getPreparations: query({
    input: schemas.getMealPreparationsInput,
    output: schemas.getMealPreparationsOut,
  }),
  getShoppingList: query({
    input: schemas.shoppingListInput,
    output: schemas.shoppingListOut,
  }),
  addRecipe: mutation({
    input: schemas.mealAddRecipeInput,
    output: schemas.mealOut,
  }),
  updateRecipe: mutation({
    input: schemas.mealUpdateRecipeInput,
    output: schemas.mealOut,
  }),
  removeRecipe: mutation({
    input: schemas.mealRecipeIdInput,
    output: schemas.mealOut,
  }),
  savePreparation: mutation({
    input: schemas.saveMealRecipePreparationInput,
    output: schemas.saveMealRecipePreparationOut,
  }),
});
