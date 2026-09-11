import { describe, expect, it } from "vitest";

import { getEntityEmbeddingDeletedAt } from "~/server/repo/entity-embedding";
import {
  deleteExpensesWithPurchaseEffects,
  moveExpenses,
} from "~/server/repo/expense";
import { previewMergeIngredientCandidates } from "~/server/repo/ingredient/merge";
import { updateInventoryEntry } from "~/server/repo/inventory";
import {
  getLocationByShortcode,
  locationOptions,
} from "~/server/repo/location";
import {
  createMealWithEntityId,
  deleteMeals,
  getMealByID,
  updateMeal,
} from "~/server/repo/meal";
import {
  batchTotalsFor,
  portionTotalsFor,
  yieldBasisFor,
} from "~/server/repo/meal/portions";
import { findEntitiesMissingEmbeddings } from "~/server/repo/problems";
import { setProductsStockTracked } from "~/server/repo/product";
import {
  getRecipeByShortcode,
  updateRecipe,
  upsertNotionRecipe,
} from "~/server/repo/recipe";
import { getRecipeTotalsStateIncludingDeleted } from "~/server/repo/recipe/totals";
import {
  createMealFixture,
  makeImportRecipe,
} from "~/server/repo/repo.fixtures";
import { moveTasks, setTasksStatus } from "~/server/repo/task";
import { previewMergeVendors } from "~/server/repo/vendor";
import {
  findAllProblems,
  rebuildProductConversionCoverageProjection,
} from "~/server/services/problems.service";

describe("retained repository API surface", () => {
  it("keeps pre-rewrite production exports callable", () => {
    const retainedFunctions = [
      getEntityEmbeddingDeletedAt,
      deleteExpensesWithPurchaseEffects,
      moveExpenses,
      previewMergeIngredientCandidates,
      updateInventoryEntry,
      getLocationByShortcode,
      locationOptions,
      createMealWithEntityId,
      deleteMeals,
      getMealByID,
      updateMeal,
      batchTotalsFor,
      portionTotalsFor,
      yieldBasisFor,
      findEntitiesMissingEmbeddings,
      setProductsStockTracked,
      getRecipeByShortcode,
      updateRecipe,
      upsertNotionRecipe,
      getRecipeTotalsStateIncludingDeleted,
      createMealFixture,
      makeImportRecipe,
      moveTasks,
      setTasksStatus,
      previewMergeVendors,
      findAllProblems,
      rebuildProductConversionCoverageProjection,
    ];

    for (const retainedFunction of retainedFunctions) {
      expect(retainedFunction).toBeTypeOf("function");
    }
  });
});
