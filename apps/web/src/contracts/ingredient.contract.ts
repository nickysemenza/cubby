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
    mcp: {
      omit: "kernel_alternative",
      kernel: ["resolve", "search"],
      note: "entity_read.resolve reports ingredientHits by name or alias; entity_read.search on ingredients",
    },
    input: schemas.ingredientNameFilterInput,
    output: schemas.ingredientWithFoodOut.nullable(),
    cache: { profile: "stable" },
  }),
  matchNames: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["resolve", "search"],
      note: "entity_read.resolve reports ingredientHits by name or alias; entity_read.search on ingredients",
    },
    input: schemas.ingredientNamesInput,
    output: schemas.ingredientMatchesOut,
  }),
  getManyByIDs: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on ingredients",
    },
    input: schemas.ingredientIdsInput,
    output: schemas.ingredientWithFoodLeanListOut,
  }),
  recipeUsages: query({
    input: schemas.ingredientIdInput,
    output: schemas.ingredientRecipeUsagesOut,
    cache: { tags: [["ingredient", "recipeUsages"], ["recipe"]] },
  }),
  resolveOrCreate: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["resolveOrCreate"],
      note: "entity.resolve with entity ingredient",
    },
    input: schemas.ingredientResolvableNamesInput,
    output: schemas.ingredientResolveOrCreateOut,
    invalidates: ["ingredient"],
  }),
  enrichmentWorkbench: query({
    mcp: { omit: "client_view" },
    input: schemas.enrichmentWorkbenchInput,
    output: schemas.enrichmentRowsOut,
  }),
  merge: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["merge"],
      note: "entity.merge with entity ingredient",
    },
    input: schemas.ingredientMergeInput,
    output: mergeOutput,
    invalidates: ["ingredientMerge"],
  }),
});
