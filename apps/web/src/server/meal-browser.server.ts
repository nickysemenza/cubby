import { mealContract } from "~/contracts/meal.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import * as workflow from "~/server/workflows/meal.server";

export const mealHandlers = implementOperationDomain(mealContract, {
  getNutrition: (context, input) =>
    workflow.getMealNutritionWorkflow(
      context.readDb,
      input,
      context.usdaClient,
      context.services.recipeCosting,
    ),
  saveFood: (context, input) =>
    workflow.saveMealFoodWorkflow(context.db, input, context.actorContext),
  removeFood: (context, input) =>
    workflow.removeMealFoodWorkflow(context.db, input, context.actorContext),
  getByDateRange: (context, input) =>
    workflow.getMealsByDateRangeWorkflow(context.db, input),
  upcomingSummary: (context, input) =>
    workflow.getUpcomingMealSummaryWorkflow(context.db, input),
  getPreparations: (context, input) =>
    workflow.getMealPreparationsWorkflow(
      context.readDb,
      input,
      context.services.recipeCosting,
    ),
  getShoppingList: (context, input) =>
    workflow.getShoppingListWorkflow(
      context.db,
      input,
      context.services.availability,
    ),
  addRecipe: async (context, input) =>
    (
      await workflow.addRecipeToMealWorkflow(
        context.db,
        input,
        context.actorContext,
      )
    ).meal,
  updateRecipe: (context, input) =>
    workflow.updateMealRecipeWorkflow(context.db, input, context.actorContext),
  removeRecipe: (context, input) =>
    workflow.removeMealRecipeWorkflow(context.db, input, context.actorContext),
  savePreparation: (context, input) =>
    workflow.saveMealRecipePreparationWorkflow(
      context.db,
      input,
      context.actorContext,
    ),
});
