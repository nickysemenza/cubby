import { ingredientFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/ingredient";
import * as schemas from "@cubby/schemas/ingredient";
import { mutationSideEffectsSchema } from "@cubby/schemas/mutation-side-effects";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const mergeOutput = z.object({
  ingredient: schemas.ingredientOut,
  mergeSummary: schemas.mergeSummary,
  sideEffects: mutationSideEffectsSchema,
});

export const ingredientManyRead = schemas.ingredientWithFoodLeanOut;
export const ingredientEnrichmentRead = schemas.enrichmentRowOut;
export type IngredientEnrichmentRead = z.output<
  typeof ingredientEnrichmentRead
>;

export const ingredientContract = defineContract(
  "ingredient",
  {
    getByName: query({
      note: "entity_read.resolve reports ingredientHits by name or alias; entity_read.search on ingredients",
      input: schemas.ingredientNameFilterInput,
      output: ingredientFieldEnvelopeSchemas.detail.nullable(),
      cache: { profile: "stable" },
    }),
    matchNames: query({
      note: "entity_read.resolve reports ingredientHits by name or alias; entity_read.search on ingredients",
      input: schemas.ingredientNamesInput,
      output: schemas.ingredientMatchesOut,
    }),
    getManyByIDs: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on ingredients",
      input: schemas.ingredientIdsInput,
      output: z.array(ingredientManyRead),
    }),
    recipeUsages: query({
      exposure: "capability",
      description:
        "Reverse lookup: every recipe that uses an ingredient, with each line's `lineId` for recipe_insights.patch_line.",
      input: schemas.ingredientIdInput,
      output: schemas.ingredientRecipeUsagesOut,
      cache: { tags: [["ingredient", "recipeUsages"], ["recipe"]] },
    }),
    resolveOrCreate: mutation({
      note: "entity.resolve with entity ingredient",
      input: schemas.ingredientResolvableNamesInput,
      output: schemas.ingredientResolveOrCreateOut,
      invalidates: ["ingredient"],
    }),
    enrichmentWorkbench: query({
      input: schemas.enrichmentWorkbenchInput,
      output: z.array(ingredientEnrichmentRead),
    }),
    merge: mutation({
      note: "entity.merge with entity ingredient",
      input: schemas.ingredientMergeInput,
      output: mergeOutput,
      invalidates: ["ingredientMerge"],
    }),
  },
  { exposure: "view", mcpToolGroup: "recipe_insights" },
);
