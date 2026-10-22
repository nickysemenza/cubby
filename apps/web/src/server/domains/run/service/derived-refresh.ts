import type { RecipeId } from "@cubby/schemas/identifiers";

import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";

/** Captures authoritative recipe inputs before provider work outside publication. */
export const prepareRecipeRefresh = (db: Database, id: RecipeId) =>
  new RecipeCostingService(db, {
    findFoodsBatch: (lookups) =>
      new USDAClient(requestUsdaRelease()).findFoodsBatch(lookups),
  }).prepareRefresh(id);
