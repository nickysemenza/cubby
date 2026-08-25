import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import * as workflow from "~/server/workflows/meal.server";

export const getMealsByDateRangeForBrowser = (o: {
  data: z.input<typeof workflow.mealDateRange>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.getByDateRange",
    type: "query",
    input: o.data,
    inputSchema: workflow.mealDateRange,
    outputSchema: workflow.mealListOut,
    request: o.request,
    run: (c, i) => workflow.getMealsByDateRangeWorkflow(c.db, i),
  });
export const getUpcomingMealSummaryForBrowser = (o: {
  data: z.input<typeof workflow.mealDateRange>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.upcomingSummary",
    type: "query",
    input: o.data,
    inputSchema: workflow.mealDateRange,
    outputSchema: workflow.upcomingMealSummaryOut,
    request: o.request,
    run: (c, i) => workflow.getUpcomingMealSummaryWorkflow(c.db, i),
  });
export const getShoppingListForBrowser = (o: {
  data: z.input<typeof workflow.mealDateRange>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.getShoppingList",
    type: "query",
    input: o.data,
    inputSchema: workflow.mealDateRange,
    outputSchema: workflow.shoppingListOut,
    request: o.request,
    run: (c, i) =>
      workflow.getShoppingListWorkflow(c.db, i, c.services.availability),
  });
export const addRecipeToMealForBrowser = (o: {
  data: z.input<typeof workflow.mealAddRecipeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.addRecipe",
    type: "mutation",
    input: o.data,
    inputSchema: workflow.mealAddRecipeInput,
    outputSchema: workflow.mealOut,
    request: o.request,
    run: (c, i) => workflow.addRecipeToMealWorkflow(c.db, i, c.actorContext),
  });
export const updateMealRecipeForBrowser = (o: {
  data: z.input<typeof workflow.mealUpdateRecipeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.updateRecipe",
    type: "mutation",
    input: o.data,
    inputSchema: workflow.mealUpdateRecipeInput,
    outputSchema: workflow.mealOut,
    request: o.request,
    run: (c, i) => workflow.updateMealRecipeWorkflow(c.db, i, c.actorContext),
  });
export const removeMealRecipeForBrowser = (o: {
  data: z.input<typeof workflow.mealRecipeIdInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "meal.removeRecipe",
    type: "mutation",
    input: o.data,
    inputSchema: workflow.mealRecipeIdInput,
    outputSchema: workflow.mealOut,
    request: o.request,
    run: (c, i) => workflow.removeMealRecipeWorkflow(c.db, i, c.actorContext),
  });
