import type { Amount } from "@cubby/schemas/codec";
import { unsafeIngredientShortcode } from "@cubby/schemas/identifiers";
import { makeableRecipesOut } from "@cubby/schemas/suggestions";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createRecipe } from "~/server/repo/recipe";
import {
  makeRecipeInput,
  seedIngredientWithStock,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getFlowWorkflow, getMakeableWorkflow } from "./recipe.server";

describe("recipe workflows", () => {
  const ctx = withTestDb();
  const requestContext = () =>
    createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });

  const createIngredientRecipe = async (
    name: string,
    ingredientId: string,
    need: Amount,
  ) =>
    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
        sections: [
          {
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientShortcode(ingredientId),
                recipeId: null,
                amounts: [need],
              },
            ],
            instructions: [{ instruction: "Mix" }],
          },
        ],
      }),
      ctx.actor,
    );

  it("resolves a public recipe shortcode through the flow workflow", async () => {
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Flow shortcode recipe" }),
      ctx.actor,
    );

    await expect(
      getFlowWorkflow(ctx.db, { id: recipe.id }),
    ).resolves.toMatchObject({ status: "missing" });
  });

  it("returns schema-valid makeable recipes ranked by coverage", async () => {
    const flour = await seedIngredientWithStock(
      ctx.db,
      { name: "workflow flour", onHand: { value: 500, unit: "g" } },
      ctx.actor,
    );
    const sugar = await seedIngredientWithStock(
      ctx.db,
      { name: "workflow sugar", onHand: { value: 10, unit: "g" } },
      ctx.actor,
    );
    await createIngredientRecipe("Ready Recipe", flour.shortcode, {
      value: 2,
      unit: "cup",
    });
    await createIngredientRecipe("Short Recipe", sugar.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = makeableRecipesOut.parse(
      await getMakeableWorkflow(
        ctx.db,
        {},
        requestContext().services.availability,
      ),
    );
    expect(result.recipes.map((recipe) => recipe.recipeName)).toEqual([
      "Ready Recipe",
      "Short Recipe",
    ]);
    expect(result.recipes[0]?.coverage).toBeGreaterThanOrEqual(
      result.recipes[1]?.coverage ?? 0,
    );
    expect(result.truncated).toBe(false);

    const readyOnly = await getMakeableWorkflow(
      ctx.db,
      { minCoverage: 1 },
      requestContext().services.availability,
    );
    expect(readyOnly.recipes.map((recipe) => recipe.recipeName)).toEqual([
      "Ready Recipe",
    ]);
  });

  it("excludes recipes that are only sub-recipe components", async () => {
    const flour = await seedIngredientWithStock(
      ctx.db,
      { name: "subrecipe flour", onHand: { value: 500, unit: "g" } },
      ctx.actor,
    );
    const subRecipe = await createIngredientRecipe(
      "Sub Recipe",
      flour.shortcode,
      { value: 2, unit: "cup" },
    );
    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Parent Recipe",
        sections: [
          {
            ingredients: [
              {
                type: "recipe" as const,
                ingredientId: null,
                recipeId: subRecipe.id,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
            instructions: [{ instruction: "Assemble" }],
          },
        ],
      }),
      ctx.actor,
    );

    const result = await getMakeableWorkflow(
      ctx.db,
      {},
      requestContext().services.availability,
    );
    expect(result.recipes.map((recipe) => recipe.recipeName)).toEqual([
      "Parent Recipe",
    ]);
  });
});
