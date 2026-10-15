import type { ProductId } from "@cubby/schemas/identifiers";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { loadIngredientIdsForProducts } from "~/server/domains/product/repo/pricing";
import type { RecipeCostingService } from "~/server/domains/recipe/service/recipe-costing.service";

/**
 * Expense writes own historical unit-cost changes; recipes depend on the
 * affected Products' ingredients. Keep this cross-repo dispatch in a service,
 * while the Expense repo owns the transactional valuation refresh.
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
