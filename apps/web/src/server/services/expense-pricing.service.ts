import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ProductId } from "@cubby/schemas/identifiers";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { loadIngredientIdsForProducts } from "~/server/repo/product/pricing";
import type { RecipeCostingService } from "./recipe-costing.service";

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
): Promise<BackgroundBatchRef[]> => {
  const ids = uniq(productIds);
  if (ids.length === 0) return [];
  const ingredientIds = await loadIngredientIdsForProducts(db, ids);
  return await recipeCosting.recomputeForIngredients(uniq(ingredientIds), {
    source,
  });
};
