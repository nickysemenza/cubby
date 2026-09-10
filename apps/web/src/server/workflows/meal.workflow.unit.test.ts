import { describe, expect, it } from "vitest";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";

import {
  addRecipeToMealWorkflow,
  getMealPreparationsWorkflow,
  getMealsByDateRangeWorkflow,
  getUpcomingMealSummaryWorkflow,
  removeMealRecipeWorkflow,
  saveMealRecipePreparationWorkflow,
  updateMealRecipeWorkflow,
} from "./meal.server";

describe("meal workflow ownership", () => {
  it("registers each migrated workflow under its public operation identity", () => {
    for (const operation of [
      getMealsByDateRangeWorkflow,
      getUpcomingMealSummaryWorkflow,
      getMealPreparationsWorkflow,
      saveMealRecipePreparationWorkflow,
      addRecipeToMealWorkflow,
      updateMealRecipeWorkflow,
      removeMealRecipeWorkflow,
    ]) {
      expect(
        startOperationDefinitionFor(operation.definition.name),
      ).toBeDefined();
    }
  });
});
