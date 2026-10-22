import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectStaleRecipeIds } from "~/server/domains/recipe/repo/totals";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
  drainRecipeRefreshJobs,
} from "~/server/testing/background-queue";
import {
  createIngredientFixture,
  createProductIdentityFixture,
  createRecipeFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { recomputeRecipesForPriceAffectedProducts } from "./price-affected-recipes";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

describe("recomputeRecipesForPriceAffectedProducts", () => {
  const ctx = withTestDb();

  it("dispatches once for the unique linked ingredients", async () => {
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "Costed ingredient", aliases: [] },
      ctx.actor,
    );
    const linked = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ ingredientId: ingredient.id }),
      ctx.actor,
    );
    const unlinked = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Non-food product" }),
      ctx.actor,
    );
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Expense-priced recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ingredient.id)],
          },
        ],
      }),
      ctx.actor,
    );
    const service = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting;

    await drainDerivedRefreshFrontier(ctx.db);
    await service.recomputeQueued([recipe.entityId]);
    await drainRecipeRefreshJobs(ctx.db, service);
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([]);
    await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      service,
      [linked.entityId, linked.entityId, unlinked.entityId],
      "expense.test",
    );

    await drainDerivedRefreshFrontier(ctx.db);
    await drainRecipeRefreshJobs(ctx.db, service);
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([]);
  });
});
