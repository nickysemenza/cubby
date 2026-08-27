import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import * as schemas from "@cubby/schemas/ingredient";
import { z } from "zod";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

const mergeOutput = z.object({
  ingredient: schemas.ingredientOut,
  mergeSummary: schemas.ingredientMergeOut.shape.mergeSummary,
  sideEffects: mutationSideEffectsSchema,
});

export const ingredient = defineOperationDomain("ingredient", {
  getByName: query({
    input: schemas.ingredientNameFilterInput,
    output: schemas.ingredientWithFoodOut.nullable(),
    tags: [["ingredient", "getByName"]],
  }),
  matchNames: query({
    input: schemas.ingredientNamesInput,
    output: schemas.ingredientMatchesOut,
    tags: [["ingredient", "matchNames"]],
  }),
  getManyByIDs: query({
    input: schemas.ingredientIdsInput,
    output: schemas.ingredientWithFoodLeanListOut,
    tags: [["ingredient", "getManyByIDs"]],
  }),
  recipeUsages: query({
    input: schemas.ingredientIdInput,
    output: schemas.ingredientRecipeUsagesOut,
    tags: [["ingredient", "recipeUsages"], ["recipe"]],
  }),
  resolveOrCreate: mutation({
    input: schemas.ingredientResolvableNamesInput,
    output: schemas.ingredientResolveOrCreateOut,
    invalidates: ripple.ingredient,
  }),
  enrichmentWorkbench: query({
    input: schemas.enrichmentWorkbenchInput,
    output: schemas.enrichmentRowsOut,
    tags: [["ingredient", "enrichmentWorkbench"]],
  }),
  merge: mutation({
    input: schemas.ingredientMergeInput,
    output: mergeOutput,
    invalidates: ripple.ingredientMerge,
  }),
});
