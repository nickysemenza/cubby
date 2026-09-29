import * as schemas from "@cubby/schemas/ingredient";
import { mutationSideEffectsSchema } from "@cubby/schemas/mutation-side-effects";
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
    cache: { profile: "stable" },
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
    cache: { tags: [["ingredient", "recipeUsages"], ["recipe"]] },
  }),
  resolveOrCreate: mutation({
    input: schemas.ingredientResolvableNamesInput,
    output: schemas.ingredientResolveOrCreateOut,
    invalidates: ["ingredient"],
  }),
  enrichmentWorkbench: query({
    input: schemas.enrichmentWorkbenchInput,
    output: schemas.enrichmentRowsOut,
  }),
  merge: mutation({
    input: schemas.ingredientMergeInput,
    output: mergeOutput,
    invalidates: ["ingredientMerge"],
  }),
});
