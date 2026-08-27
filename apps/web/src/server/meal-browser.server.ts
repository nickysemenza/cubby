import { meal } from "~/app/meals/meal.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import * as workflow from "~/server/workflows/meal.server";

export const mealHandlers = implementOperationDomain(meal, {
  getByDateRange: (context, input) =>
    workflow.getMealsByDateRangeWorkflow(context.db, input),
  upcomingSummary: (context, input) =>
    workflow.getUpcomingMealSummaryWorkflow(context.db, input),
  getShoppingList: (context, input) =>
    workflow.getShoppingListWorkflow(
      context.db,
      input,
      context.services.availability,
    ),
  addRecipe: (context, input) =>
    workflow.addRecipeToMealWorkflow(context.db, input, context.actorContext),
  updateRecipe: (context, input) =>
    workflow.updateMealRecipeWorkflow(context.db, input, context.actorContext),
  removeRecipe: (context, input) =>
    workflow.removeMealRecipeWorkflow(context.db, input, context.actorContext),
});
