import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import * as schemas from "@cubby/schemas/ingredient";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const mergeOutput = z.object({
  ingredient: schemas.ingredientOut,
  mergeSummary: schemas.ingredientMergeOut.shape.mergeSummary,
  sideEffects: mutationSideEffectsSchema,
});

export const ingredientContract = defineContract("ingredient", {
  getByName: query({
    input: schemas.ingredientNameFilterInput,
    output: schemas.ingredientWithFoodOut.nullable(),
  }),
  matchNames: query({
    input: schemas.ingredientNamesInput,
    output: schemas.ingredientMatchesOut,
  }),
  getManyByIDs: query({
    input: schemas.ingredientIdsInput,
    output: schemas.ingredientWithFoodLeanListOut,
  }),
  recipeUsages: query({
    input: schemas.ingredientIdInput,
    output: schemas.ingredientRecipeUsagesOut,
  }),
  resolveOrCreate: mutation({
    input: schemas.ingredientResolvableNamesInput,
    output: schemas.ingredientResolveOrCreateOut,
  }),
  enrichmentWorkbench: query({
    input: schemas.enrichmentWorkbenchInput,
    output: schemas.enrichmentRowsOut,
  }),
  merge: mutation({
    input: schemas.ingredientMergeInput,
    output: mergeOutput,
  }),
});
