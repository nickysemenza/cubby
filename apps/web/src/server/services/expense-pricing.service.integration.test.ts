import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  createIngredientFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { recomputeRecipesForPriceAffectedProducts } from "./expense-pricing.service";
import type { RecipeCostingService } from "./recipe-costing.service";

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
    const recomputeForIngredients = vi.fn().mockResolvedValue([]);
    const service = {
      recomputeForIngredients,
    } as unknown as RecipeCostingService;

    const result = await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      service,
      [linked.entityId, linked.entityId, unlinked.entityId],
      "expense.test",
    );

    expect(result).toEqual([]);
    expect(recomputeForIngredients).toHaveBeenCalledOnce();
    expect(recomputeForIngredients).toHaveBeenCalledWith(
      [ingredient.entityId],
      { source: "expense.test" },
    );
  });
});
