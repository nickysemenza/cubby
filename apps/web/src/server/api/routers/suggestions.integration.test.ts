import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import { createTestCaller } from "../trpc";
import { recipeRouter } from "./recipe";
import { suggestionsRouter } from "./suggestions";

const CUP_TO_GRAM = {
  a: { value: 1, unit: "cup" },
  b: { value: 120, unit: "g" },
  source: null,
};

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
  const seedIngredientWithStock = async (name: string, onHand: Amount) => {
    const ing = await findOrCreateIngredient(ctx.db, name);
    const loc = await createLocation(
      ctx.db,
      { name: `Pantry-${name}`, type: "room", parentId: null },
      TEST_ACTOR,
    );
    if (!loc) throw new Error("seed: location not created");
    const prod = await createProduct(
      ctx.db,
      {
        name: `Test ${name}`,
        manufacturer: "test",
        upc: null,
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: ing.id,
        unitMappings: [CUP_TO_GRAM],
        externalIds: [],
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: loc.id,
        amount: onHand,
      },
      TEST_ACTOR,
    );
    return ing;
  };

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
