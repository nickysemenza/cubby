import { RECIPE_RECOMPUTE_CHUNK_SIZE } from "@cubby/schemas/background-tasks";
import type { RecipeId } from "@cubby/schemas/identifiers";

import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { selectStaleRecipeIds } from "~/server/repo/recipe/totals";

import type { RecipeCostingService } from "./recipe-costing.service";

/** Best-effort, bounded repair shared by every totals-dependent read. */
export async function repairStaleRecipesForRead(
  recipeCosting: RecipeCostingService,
  recipeIds: readonly RecipeId[],
  source: string,
): Promise<boolean> {
  const stale = await selectStaleRecipeIds(recipeCosting.database, [
    ...new Set(recipeIds),
  ]);
  if (stale.length > 0) {
    try {
      for (
        let start = 0;
        start < stale.length;
        start += RECIPE_RECOMPUTE_CHUNK_SIZE
      ) {
        const chunk = stale.slice(start, start + RECIPE_RECOMPUTE_CHUNK_SIZE);
        try {
          await recipeCosting.recomputeQueued(chunk);
        } catch (error) {
          console.warn(`[${source}] repair-on-read failed`, {
            recipes: chunk,
            error,
          });
        }
      }
    } finally {
      // Repairs can partially commit before an error; extend the strong-read
      // window for every attempted stale repair.
      await recordDatabaseWrite(`${source}.repair-stale-recipes`);
    }
  }
  return stale.length > 0;
}
