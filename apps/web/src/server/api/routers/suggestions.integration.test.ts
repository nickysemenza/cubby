import type { Amount } from "@cubby/schemas/codec";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { seedIngredientWithStock as seedStock } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { recipeRouter } from "./recipe";
import { suggestionsRouter } from "./suggestions";

describe("suggestions router", () => {
  const ctx = withTestDb();
  let recipeCaller: ReturnType<
    typeof createTestCaller<(typeof recipeRouter)["_def"]["record"]>
  >;
  let suggestionsCaller: ReturnType<
    typeof createTestCaller<(typeof suggestionsRouter)["_def"]["record"]>
  >;

  beforeEach(() => {
    recipeCaller = createTestCaller(recipeRouter, ctx.db);
    suggestionsCaller = createTestCaller(suggestionsRouter, ctx.db);
  });

  const createRecipe = (name: string, ingredientId: string, need: Amount) =>
    recipeCaller.create({
      name,
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId,
              recipeId: null,
              amounts: [need],
            },
          ],
          instructions: [{ instruction: "Mix" }],
        },
      ],
    });

  const seedIngredientWithStock = (name: string, onHand: Amount) =>
    seedStock(ctx.db, { name, onHand }, TEST_ACTOR);

  it("getRecipeAvailability output satisfies the published schema", async () => {
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const recipe = await createRecipe("Pancakes", flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await suggestionsCaller.getRecipeAvailability({
      recipeId: recipe.id,
    });

    expect(result.coverage).toBe(1);
  });

  it("getMakeable ranks by coverage desc and honors minCoverage", async () => {
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const sugar = await seedIngredientWithStock("sugar", {
      value: 10,
      unit: "g",
    });
    await createRecipe("Ready Recipe", flour.shortcode, {
      value: 2,
      unit: "cup",
    });
    await createRecipe("Short Recipe", sugar.shortcode, {
      value: 2,
      unit: "cup",
    });

    const all = await suggestionsCaller.getMakeable({});
    expect(all.recipes).toHaveLength(2);
    expect(all.recipes[0]?.coverage).toBeGreaterThanOrEqual(
      all.recipes[1]?.coverage ?? 0,
    );
    expect(all.recipes[0]?.recipeName).toBe("Ready Recipe");
    expect(all.truncated).toBe(false);

    const readyOnly = await suggestionsCaller.getMakeable({ minCoverage: 1 });
    expect(readyOnly.recipes).toHaveLength(1);
    expect(readyOnly.recipes[0]?.recipeName).toBe("Ready Recipe");
  });

  // A recipe used as an ingredient by another recipe is a component, not an
  // answer to "what can I make?" — it must not appear in the candidate pool.
  it("getMakeable excludes recipes used as sub-recipes", async () => {
    const flour = await seedIngredientWithStock("sub flour", {
      value: 500,
      unit: "g",
    });
    const sub = await createRecipe("Sub Recipe", flour.shortcode, {
      value: 2,
      unit: "cup",
    });
    const parent = await recipeCaller.create({
      name: "Parent Recipe",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "recipe" as const,
              ingredientId: null,
              recipeId: sub.id,
              amounts: [{ value: 1, unit: "each" }],
            },
          ],
          instructions: [{ instruction: "Assemble" }],
        },
      ],
    });

    const { recipes } = await suggestionsCaller.getMakeable({});
    expect(recipes.map((r) => r.recipeName)).toEqual(["Parent Recipe"]);

    // Dropping the sub-recipe line only soft-deletes the LINK — the pointer
    // Ingredient row survives — so the exclusion has to key off the live link or
    // "Sub Recipe" would stay hidden from suggestions forever.
    await recipeCaller.update({
      id: parent.id,
      data: {
        sections: [
          {
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: flour.shortcode,
                recipeId: null,
                amounts: [{ value: 1, unit: "cup" }],
              },
            ],
            instructions: [{ instruction: "Assemble" }],
          },
        ],
      },
    });

    const after = await suggestionsCaller.getMakeable({});
    expect(after.recipes.map((r) => r.recipeName).sort()).toEqual([
      "Parent Recipe",
      "Sub Recipe",
    ]);
  });
});
