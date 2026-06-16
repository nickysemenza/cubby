import type { Amount } from "@cubby/schemas/codec";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import { recipeRouter } from "../api/routers/recipe";
import { createTestCaller, createTestTRPCContext } from "../api/trpc";

// A product linked to "flour" with "1 cup = 120 g", so on-hand grams reconcile
// against a recipe that asks for cups (the core unit-conversion path).
const CUP_TO_GRAM = {
  a: { value: 1, unit: "cup" },
  b: { value: 120, unit: "g" },
  source: null,
};

describe("AvailabilityService.getRecipeAvailability", () => {
  const tdb = withTestDb();

  const ctx = () =>
    createTestTRPCContext(tdb.db, { auth: { userId: TEST_ACTOR.userId } });

  const createFlourRecipe = (ingredientId: string, need: Amount) =>
    createTestCaller(recipeRouter, tdb.db).create({
      name: "Pancakes",
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

  // Seed a "flour" ingredient with one linked product (cup<->g) holding `onHand`.
  const seedFlourWithStock = async (onHand: Amount) => {
    const flour = await findOrCreateIngredient(tdb.db, "flour");
    const loc = await createLocation(
      tdb.db,
      { name: "Pantry", type: "room", parentId: null },
      TEST_ACTOR,
    );
    if (!loc) throw new Error("seed: location not created");
    const prod = await createProduct(
      tdb.db,
      {
        name: "Test Flour",
        manufacturer: "test",
        upc: null,
        ndb_number: null,
        fdc_id: null,
        expectedQuantity: null,
        ingredientId: flour.id,
        unitMappings: [CUP_TO_GRAM],
        externalIds: [],
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      tdb.db,
      {
        productId: prod.id,
        locationId: loc.id,
        amount: onHand,
      },
      TEST_ACTOR,
    );
    return flour;
  };

  it("reports ok when inventory covers the recipe (across a unit conversion)", async () => {
    const flour = await seedFlourWithStock({ value: 500, unit: "g" }); // ~4.17 cups
    const recipe = await createFlourRecipe(flour.id, { value: 2, unit: "cup" });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(1);
    expect(result.totalIngredients).toBe(1);
    expect(result.availableIngredients).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.ingredients[0]!.status).toBe("ok");
    expect(result.ingredients[0]!.basisUnit).toBe("g");
    expect(result.ingredients[0]!.needValue).toBeCloseTo(240, 1); // 2 cups
    expect(result.ingredients[0]!.haveValue).toBeCloseTo(500, 1); // 500 g on hand
  });

  it("reports short when inventory is insufficient", async () => {
    const flour = await seedFlourWithStock({ value: 100, unit: "g" }); // ~0.83 cups
    const recipe = await createFlourRecipe(flour.id, { value: 2, unit: "cup" });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(0);
    expect(result.ingredients[0]!.status).toBe("short");
    expect(result.missing).toEqual(["flour"]);
  });

  it("reports missing when nothing is on hand", async () => {
    const flour = await findOrCreateIngredient(tdb.db, "flour");
    const recipe = await createFlourRecipe(flour.id, { value: 2, unit: "cup" });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(0);
    expect(result.ingredients[0]!.status).toBe("missing");
    expect(result.ingredients[0]!.haveValue).toBeNull();
  });

  it("reports unconvertible when units can't be reconciled", async () => {
    // On hand in "widget", but the only mapping is cup<->g: no path to "cup".
    const flour = await seedFlourWithStock({ value: 3, unit: "widget" });
    const recipe = await createFlourRecipe(flour.id, { value: 2, unit: "cup" });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.ingredients[0]!.status).toBe("unconvertible");
    expect(result.ingredients[0]!.haveValue).toBeNull();
    expect(result.coverage).toBe(0);
  });
});
