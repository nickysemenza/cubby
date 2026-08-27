import * as schemas from "@cubby/schemas/meal";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const meal = defineOperationDomain("meal", {
  getByDateRange: query({
    input: schemas.mealDateRange,
    output: schemas.mealListOut,
    tags: [["meal", "getByDateRange"]],
  }),
  upcomingSummary: query({
    input: schemas.mealDateRange,
    output: schemas.upcomingMealSummaryOut,
    tags: [["meal", "upcomingSummary"]],
  }),
  getShoppingList: query({
    input: schemas.mealDateRange,
    output: schemas.shoppingListOut,
    tags: [["meal", "getShoppingList"]],
  }),
  addRecipe: mutation({
    input: schemas.mealAddRecipeInput,
    output: schemas.mealOut,
    invalidates: ripple.meal,
  }),
  updateRecipe: mutation({
    input: schemas.mealUpdateRecipeInput,
    output: schemas.mealOut,
    invalidates: ripple.meal,
  }),
  removeRecipe: mutation({
    input: schemas.mealRecipeIdInput,
    output: schemas.mealOut,
    invalidates: ripple.meal,
  }),
});
