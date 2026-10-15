import type { ProductId } from "@cubby/schemas/identifiers";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { loadIngredientIdsForProducts } from "~/server/domains/product/repo/pricing";
import type { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";

/**
 * Expense writes own historical unit-cost changes; recipes depend on the
 * affected Products' ingredients. The recompute itself stays behind the
 * injected `RecipeCostingService`; this only resolves which ingredients to hand it.
 */
export const recomputeRecipesForPriceAffectedProducts = async (
  db: Database,
  recipeCosting: RecipeCostingService,
  productIds: readonly ProductId[],
  source: string,
): Promise<number> => {
  const ids = uniq(productIds);
  if (ids.length === 0) return 0;
  const ingredientIds = await loadIngredientIdsForProducts(db, ids);
  return await recipeCosting.recomputeForIngredients(uniq(ingredientIds), {
    source,
  });
};
