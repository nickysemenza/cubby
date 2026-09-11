import { ingredientContract } from "~/contracts/ingredient.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const ingredient = defineOperationDomain(ingredientContract, {
  getByName: { tags: [["ingredient", "getByName"]], cache: "stable" },
  matchNames: { tags: [["ingredient", "matchNames"]] },
  getManyByIDs: { tags: [["ingredient", "getManyByIDs"]] },
  recipeUsages: { tags: [["ingredient", "recipeUsages"], ["recipe"]] },
  resolveOrCreate: { invalidates: ripple.ingredient },
  enrichmentWorkbench: { tags: [["ingredient", "enrichmentWorkbench"]] },
  merge: { invalidates: ripple.ingredientMerge },
});
