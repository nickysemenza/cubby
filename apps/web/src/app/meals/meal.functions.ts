import * as schemas from "@cubby/schemas/meal";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const meal = defineOperationDomain("meal", {
  getByDateRange: query({
    input: schemas.mealDateRange,
    output: schemas.mealListOut,
    tags: [["meal"], ["meal", "getByDateRange"]],
  }),
  upcomingSummary: query({
    input: schemas.mealDateRange,
    output: schemas.upcomingMealSummaryOut,
    tags: [["meal"], ["meal", "upcomingSummary"]],
  }),
  getShoppingList: query({
    input: schemas.mealDateRange,
    output: schemas.shoppingListOut,
    tags: [["meal"], ["meal", "getShoppingList"]],
  }),
  addRecipe: mutation({
    input: schemas.mealAddRecipeInput,
    output: schemas.mealOut,
    invalidates: [["meal"]],
  }),
  updateRecipe: mutation({
    input: schemas.mealUpdateRecipeInput,
    output: schemas.mealOut,
    invalidates: [["meal"]],
  }),
  removeRecipe: mutation({
    input: schemas.mealRecipeIdInput,
    output: schemas.mealOut,
    invalidates: [["meal"]],
  }),
});
