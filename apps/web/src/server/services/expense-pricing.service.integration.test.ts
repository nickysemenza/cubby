import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createIngredientFixture,
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { recomputeRecipesForPriceAffectedProducts } from "./expense-pricing.service";

describe("recomputeRecipesForPriceAffectedProducts", () => {
  const ctx = withTestDb();

  it("dispatches once for the unique linked ingredients", async () => {
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "Costed ingredient", aliases: [] },
      ctx.actor,
    );
    const linked = await createProductFixture(
      ctx.db,
      makeProductInput({ ingredientId: ingredient.id }),
      ctx.actor,
    );
    const unlinked = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Non-food product" }),
      ctx.actor,
    );
    await createRecipeFixture(
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

    const result = await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      service,
      [linked.entityId, linked.entityId, unlinked.entityId],
      "expense.test",
    );

    expect(result).toEqual([
      expect.objectContaining({
        kind: "recipe-totals.recompute",
        processor: "inline",
        status: "succeeded",
        totalJobs: 1,
      }),
    ]);
  });
});
