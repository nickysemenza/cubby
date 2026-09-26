import * as schemas from "@cubby/schemas/meal";

import { defineContract, mutation, query } from "~/contracts/define";

export const mealContract = defineContract("meal", {
  getNutrition: query({
    native: "Meal and daily macro summaries",
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
    mcp: {
      name: "get_shopping_list",
      description:
        "Use this when the user asks what to buy or what they are short on for planned meals in a date range. It compares aggregate recipe needs with recorded inventory. Usually-on-hand ingredients are assumed available, listed separately, and excluded from shopping estimates; assumptions never represent recorded stock. Quantity issues and blocked sub-recipes disclose incomplete information. Do not invoke it to add arbitrary manual household shopping items.",
    },
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
    mcp: {
      name: "save_meal_recipe_preparation",
      description:
        "Record measured yield and portions served from one planned recipe occurrence. Assigned portions count in daily intake by the target meal date: future is planned, today/past is logged. Confirmation fields remain for legacy compatibility and do not gate daily intake.",
    },
    input: schemas.saveMealRecipePreparationInput,
    output: schemas.saveMealRecipePreparationOut,
  }),
});
