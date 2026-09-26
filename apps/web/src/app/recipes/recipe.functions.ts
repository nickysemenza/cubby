import {
  recipeContract,
  recipeStreamsContract,
  suggestionsContract,
} from "~/contracts/recipe.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const recipe = defineOperationDomain(recipeContract, {
  getManyByIDs: { tags: [["recipe"]] },
  duplicate: { invalidates: ripple.recipeList },
  getIngredientCooccurrence: { tags: [["recipe", "cooccurrence"]] },
  getDependencyGraph: { tags: [["recipe", "dependencyGraph"]] },
  getIngredientUsage: { tags: [["recipe", "ingredientUsage"]] },
  recomputeOne: { invalidates: ripple.recipe },
  dryRunRecomputeTotals: { tags: [["recipe", "dryRun"]] },
  explainCosting: { tags: [["recipe", "costing"]] },
  getFlow: { tags: [["recipe", "flow"]] },
  generateFlow: {
    // The whole `recipe` prefix, not just the flow query: that is what the
    // legacy call site produced (its two-level key collapsed to the `["recipe"]`
    // root), and a generated flow can restate step order the costing and
    // dependency views read.
    invalidates: ripple.recipe,
  },
  harvestEquivalences: { tags: [["recipe", "equivalences"]], cache: "stable" },
  scrape: { invalidates: ripple.none },
  parseHtml: { invalidates: ripple.none },
  upsertCookbook: { invalidates: ripple.cookbook },
  getCookbookSource: { tags: [["cookbook", "source"]] },
  getCookbookDiff: { tags: [["cookbook", "diff"]] },
  previewNotionSync: { tags: [["recipe", "notionPreview"]] },
  setCookbookProduct: { invalidates: ripple.cookbookProductLink },
  deleteCookbook: { invalidates: ripple.recipeCookbook },
  forwardGatewayRequest: { invalidates: ripple.none },
  attachCookbookRecipePhoto: { invalidates: ripple.recipe },
});

export const suggestions = defineOperationDomain(suggestionsContract, {
  getRecipeAvailability: { tags: [["recipe", "availability"]] },
  getMakeable: { tags: [["recipe", "makeable"]] },
});

export const recipeStreams = defineOperationDomain(recipeStreamsContract);

export const openRecipeRecomputeAllStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeAllDurable.open(undefined, { signal });
export const openRecipeRecomputeStaleStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeStaleDurable.open(undefined, { signal });
