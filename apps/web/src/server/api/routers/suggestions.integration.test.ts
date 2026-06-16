import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { seedIngredientWithStock as seedStock } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { recipeRouter } from "./recipe";
import { suggestionsRouter } from "./suggestions";

describe("suggestions router", () => {
  const ctx = withTestDb();
  // Built fresh per test — multiple independent contexts can land on divergent
  // pooled-connection snapshots, so callers read the current `db` closure.
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

  // Single-ingredient recipe asking for `need` of `ingredientId`.
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

  // Ingredient with a linked product (cup<->g mapped) holding `onHand`.
  const seedIngredientWithStock = (name: string, onHand: Amount) =>
    seedStock(ctx.db, { name, onHand }, TEST_ACTOR);

  it("getRecipeAvailability output satisfies the published schema", async () => {
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const recipe = await createRecipe("Pancakes", flour.id, {
      value: 2,
      unit: "cup",
    });

    const result = await suggestionsCaller.getRecipeAvailability({
      recipeId: recipe.id,
    });

    // The .output() contract must accept real service output (pins schema<->service).
    expect(() => recipeAvailabilityOut.parse(result)).not.toThrow();
    expect(result.coverage).toBe(1);
  });

  it("getMakeable ranks by coverage desc and honors minCoverage", async () => {
    // "Ready Recipe": fully stocked. "Short Recipe": stocked but insufficient.
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const sugar = await seedIngredientWithStock("sugar", {
      value: 10,
      unit: "g",
    });
    await createRecipe("Ready Recipe", flour.id, { value: 2, unit: "cup" });
    await createRecipe("Short Recipe", sugar.id, { value: 2, unit: "cup" });

    const all = await suggestionsCaller.getMakeable({});
    expect(all).toHaveLength(2);
    expect(all[0]?.coverage).toBeGreaterThanOrEqual(all[1]?.coverage ?? 0);
    expect(all[0]?.recipeName).toBe("Ready Recipe");

    const readyOnly = await suggestionsCaller.getMakeable({ minCoverage: 1 });
    expect(readyOnly).toHaveLength(1);
    expect(readyOnly[0]?.recipeName).toBe("Ready Recipe");
  });
});
