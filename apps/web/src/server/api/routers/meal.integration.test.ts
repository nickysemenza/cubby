import type { Amount } from "@cubby/schemas/codec";
import { buildActorContext } from "@cubby/schemas/context";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import type { MealRecipeOut } from "@cubby/schemas/meal";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import {
  getMealsByDateRange,
  rollupMealTotals,
  scaleTotals,
} from "~/server/repo/meal";
import { createProduct } from "~/server/repo/product";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { mealRouter } from "./meal";
import { recipeRouter } from "./recipe";

const TEST_USER_ID = unsafeUserId("test-user-id");
const ACTOR = buildActorContext(TEST_USER_ID, "ui");

const CUP_TO_GRAM = {
  a: { value: 1, unit: "cup" },
  b: { value: 120, unit: "g" },
  source: null,
};

// ---------------------------------------------------------------------------
// Pure rollup math (no DB) — totals are linear in scale, so a meal's rollup is
// sum(recipe.totals × scale); a missing recipe total makes the rollup pending.
// ---------------------------------------------------------------------------
describe("rollupMealTotals / scaleTotals", () => {
  const totals = {
    costTotal: 10,
    caloriesTotal: 100,
    ingredientCount: 3,
    costCovered: 3,
    caloriesCovered: 3,
  };

  it("scales totals linearly and preserves upper bounds", () => {
    expect(scaleTotals(totals, 2)).toEqual({
      costTotal: 20,
      caloriesTotal: 200,
    });
    expect(scaleTotals({ ...totals, costTotalUpper: 12 }, 2)).toEqual({
      costTotal: 20,
      caloriesTotal: 200,
      costTotalUpper: 24,
    });
  });

  it("returns null when the recipe has no totals (never 0)", () => {
    expect(scaleTotals(null, 2)).toBeNull();
    expect(scaleTotals(undefined, 2)).toBeNull();
  });

  it("sums scaled totals and flags pending when any recipe is uncosted", () => {
    const recipes = [
      { scaledTotals: { costTotal: 10, caloriesTotal: 100 } },
      { scaledTotals: { costTotal: 20, caloriesTotal: 200 } },
    ] as MealRecipeOut[];
    expect(rollupMealTotals(recipes)).toEqual({
      costTotal: 30,
      caloriesTotal: 300,
      pending: false,
    });

    const withMissing = [...recipes, { scaledTotals: null }] as MealRecipeOut[];
    const rolled = rollupMealTotals(withMissing);
    expect(rolled.costTotal).toBe(30); // missing one contributes 0, not NaN
    expect(rolled.pending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Router behavior against a real (IntegresQL) DB.
// ---------------------------------------------------------------------------
describe("mealRouter", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  const ctx = () =>
    createTestTRPCContext(db, { auth: { userId: TEST_USER_ID } });
  const mealCaller = () => createCallerFactory(mealRouter)(ctx());
  const recipeCaller = () => createCallerFactory(recipeRouter)(ctx());

  const createRecipe = (name: string, ingredientId: string, need: Amount) =>
    recipeCaller().create({
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

  // Seed a "flour" ingredient with one linked product (cup<->g) holding `onHand`.
  const seedFlourWithStock = async (onHand: Amount) => {
    const flour = await findOrCreateIngredient(db, "flour");
    const loc = await createLocation(
      db,
      { name: "Pantry", type: "room", parentId: null },
      ACTOR,
    );
    if (!loc) throw new Error("seed: location not created");
    const prod = await createProduct(
      db,
      {
        name: "Test Flour",
        manufacturer: "test",
        upc: null,
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: flour.id,
        unitMappings: [CUP_TO_GRAM],
        externalIds: [],
      },
      ACTOR,
    );
    await createInventoryEntry(
      db,
      { productId: prod.id, locationId: loc.id, amount: onHand },
      ACTOR,
    );
    return flour;
  };

  it("plans recipes onto a day and lists them by date range", async () => {
    const flour = await findOrCreateIngredient(db, "flour");
    const recipe = await createRecipe("Pancakes", flour.id, {
      value: 2,
      unit: "cup",
    });

    const meal = await mealCaller().create({
      date: "2026-06-15",
      name: "Dinner",
    });
    await mealCaller().addRecipe({
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 2,
    });

    const inRange = await mealCaller().getByDateRange({
      from: "2026-06-14",
      to: "2026-06-16",
    });
    expect(inRange).toHaveLength(1);
    expect(inRange[0]!.name).toBe("Dinner");
    expect(inRange[0]!.recipes).toHaveLength(1);
    expect(inRange[0]!.recipes[0]!.scale).toBe(2);

    // Outside the range, nothing.
    const empty = await mealCaller().getByDateRange({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(empty).toHaveLength(0);
  });

  it("cascade-soft-deletes a meal and its planned recipes", async () => {
    const flour = await findOrCreateIngredient(db, "flour");
    const recipe = await createRecipe("Pancakes", flour.id, {
      value: 1,
      unit: "cup",
    });
    const meal = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 1,
    });

    await mealCaller().delete({ ids: [meal.id] });

    // The meal (and, via cascade, its recipes) are gone from all reads.
    const after = await getMealsByDateRange(db, "2026-06-14", "2026-06-16");
    expect(after).toHaveLength(0);
    await expect(mealCaller().getByID({ id: meal.id })).rejects.toThrow();
  });

  it("shopping list sums needs across meals but counts inventory ONCE", async () => {
    // 500 g flour on hand. Two recipes, each using flour, in two meals.
    const flour = await seedFlourWithStock({ value: 500, unit: "g" });
    const recipeA = await createRecipe("A", flour.id, {
      value: 2,
      unit: "cup",
    }); // 240 g
    const recipeB = await createRecipe("B", flour.id, {
      value: 1,
      unit: "cup",
    }); // 120 g

    const m1 = await mealCaller().create({
      date: "2026-06-15",
      name: "Lunch",
    });
    await mealCaller().addRecipe({
      mealId: m1.id,
      recipeId: recipeA.id,
      scale: 1,
    });
    const m2 = await mealCaller().create({
      date: "2026-06-15",
      name: "Dinner",
    });
    await mealCaller().addRecipe({
      mealId: m2.id,
      recipeId: recipeB.id,
      scale: 2,
    }); // 2 × 120 g

    const list = await mealCaller().getShoppingList({
      from: "2026-06-14",
      to: "2026-06-16",
    });

    expect(list.meals).toHaveLength(2);
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item.name).toBe("flour");
    expect(item.basisUnit).toBe("g");
    // Need = 240 (A) + 240 (B×2) = 480 g.
    expect(item.needValue).toBeCloseTo(480, 1);
    // Have is the on-hand 500 g counted ONCE — NOT 1000 (the double-count bug).
    expect(item.haveValue).toBeCloseTo(500, 1);
    expect(item.shortfall).toBe(0);
    expect(item.status).toBe("ok");
    // Each meal's contribution is attributed in the breakdown.
    expect(item.perMeal).toHaveLength(2);
    expect(item.perMeal.map((c) => Math.round(c.needValue)).sort()).toEqual([
      240, 240,
    ]);
  });

  it("shopping list reports a shortfall when inventory is insufficient", async () => {
    const flour = await seedFlourWithStock({ value: 300, unit: "g" });
    const recipeA = await createRecipe("A", flour.id, {
      value: 2,
      unit: "cup",
    }); // 240 g
    const recipeB = await createRecipe("B", flour.id, {
      value: 2,
      unit: "cup",
    }); // 240 g

    const m1 = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: m1.id,
      recipeId: recipeA.id,
      scale: 1,
    });
    const m2 = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: m2.id,
      recipeId: recipeB.id,
      scale: 1,
    });

    const list = await mealCaller().getShoppingList({
      from: "2026-06-14",
      to: "2026-06-16",
    });
    const item = list.items[0]!;
    expect(item.needValue).toBeCloseTo(480, 1);
    expect(item.haveValue).toBeCloseTo(300, 1);
    expect(item.shortfall).toBeCloseTo(180, 1);
    expect(item.status).toBe("short");
  });
});
