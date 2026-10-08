import type { IngredientId } from "@cubby/schemas/identifiers";

import { env } from "~/env";
import { getBindingFetcher } from "~/server/cf-env";
import { USDAClient } from "~/server/clients/usda";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { product, run } from "~/server/db/schema";
import { databaseForTransaction } from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";

export type ProductResearchEffects = {
  recomputeForIngredients?: (
    db: Database,
    ids: IngredientId[],
  ) => Promise<number>;
};

const recomputeForIngredients: NonNullable<
  ProductResearchEffects["recomputeForIngredients"]
> = (db, ids) =>
  new RecipeCostingService(
    db,
    new USDAClient(env.USDA_API_URL, getBindingFetcher("USDA_API")),
  ).recomputeForIngredients(ids, { source: "product.research" });

export async function afterProductResearchCommit(
  tx: DrizzleTransaction,
  input: {
    productId: typeof product.$inferSelect.id;
    runId: typeof run.$inferSelect.id;
    changed: boolean;
    previousIngredientId: typeof product.$inferSelect.ingredientId;
    ingredientId: IngredientId | null | undefined;
  },
  ports: ProductResearchEffects,
) {
  if (!input.changed) return;
  // Moving a priced Product also removes its contribution from the old
  // Ingredient's recipes; matching or unrelated writes do not change that link.
  const ingredientIds =
    input.ingredientId !== undefined &&
    input.ingredientId !== input.previousIngredientId
      ? [
          ...new Set(
            [input.previousIngredientId, input.ingredientId].filter(
              (id): id is IngredientId => id != null,
            ),
          ),
        ]
      : [];
  await runAfterCommit(databaseForTransaction(tx), async (committedDb) => {
    await runMutationSideEffectsForEntities(
      committedDb,
      mutationEvents(
        "product",
        "updated",
        [input.productId],
        "product.research",
      ).map((event) => ({ ...event, runId: input.runId })),
    );
    if (ingredientIds.length)
      await (ports.recomputeForIngredients ?? recomputeForIngredients)(
        committedDb,
        ingredientIds,
      );
  });
}
