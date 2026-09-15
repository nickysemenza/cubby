import {
  type LedgerPartyShortcode,
  type MealShortcode,
  parseShortcodeFor,
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { aggregateTotals } from "~/lib/nutrition-estimates";
import {
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  product,
} from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { saveMealFood, removeMealFood } from "~/server/repo/meal/food";
import { saveMealRecipePreparation } from "~/server/repo/meal/portions";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getMealNutrition } from "~/server/services/meal-nutrition.service";
import type { UsdaFoodBatchPort } from "~/server/services/usda-helpers";

const noUsda: UsdaFoodBatchPort = {
  findFoodsBatch: async () => {
    throw new Error("Label-only meal nutrition must not call USDA");
  },
};

const estimate = (value: number) => ({
  status: "complete" as const,
  lower: value,
  upper: null,
  coverage: { covered: 1, total: 1 },
});

const recipeTotals = (macros: {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}): NutritionTotals => ({
  cost: estimate(4),
  nutrition: buildNutrition((key) => {
    const value = (() => {
      switch (key) {
        case "kcal":
          return macros.kcal;
        case "protein":
          return macros.protein;
        case "carbs":
          return macros.carbs;
        case "fat":
          return macros.fat;
        default:
          return null;
      }
    })();
    return value == null
      ? { status: "unavailable", reason: "no_data" }
      : estimate(value);
  }),
});

describe("meal nutrition service", () => {
  const ctx = withTestDb();

  const mealCode = (shortcode: string): MealShortcode =>
    parseShortcodeFor("meal", shortcode);
  const partyCode = (shortcode: string): LedgerPartyShortcode =>
    parseShortcodeFor("ledgerParty", shortcode);
  const productCode = (shortcode: string): ProductShortcode =>
    parseShortcodeFor("product", shortcode);

  const seedMeal = (date: string, name: string) =>
    insertWithShortcode(ctx.db, "meal", { date, name });
  const seedParty = (name: string) =>
    insertWithShortcode(ctx.db, "ledgerParty", { name, kind: "member" });
  const seedProduct = (
    name: string,
    nutrients: { kcal: number; protein?: number; carbs?: number; fat?: number },
  ) =>
    insertWithShortcode(ctx.db, "product", {
      name,
      manufacturer: "Nutrition fixture",
      labelNutrition: {
        servingGrams: 50,
        nutrients,
        source: "Synthetic package label",
      },
    });

  it("reconciles meal, person, and day totals across an unconfirmed leftover, product, and sparse manual entry", async () => {
    const [sourceMeal, targetMeal, eater, labelledProduct, recipe] =
      await Promise.all([
        seedMeal("2026-09-14", "Cooked lunch"),
        seedMeal("2026-09-14", "Dinner leftovers"),
        seedParty("Mixed eater"),
        seedProduct("Labelled yogurt", {
          kcal: 100,
          protein: 10,
          carbs: 20,
          fat: 5,
        }),
        insertWithShortcode(ctx.db, "recipe", {
          name: "Prepared stew",
          yield: { value: 400, unit: "g" },
          totals: recipeTotals({ kcal: 400, protein: 40, carbs: 20, fat: 10 }),
          totalsComputedAt: new Date(),
        }),
      ]);
    const occurrence = await insertAndReturn(ctx.db, mealRecipe, {
      mealId: sourceMeal.id,
      recipeId: recipe.id,
      scale: 1,
    });
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        actualYieldGrams: 400,
        changes: [
          {
            action: "set",
            mealId: mealCode(targetMeal.shortcode),
            ledgerPartyId: partyCode(eater.shortcode),
            grams: 100,
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    await saveMealFood(
      ctx.db,
      {
        sourceKind: "product",
        mealId: mealCode(sourceMeal.shortcode),
        ledgerPartyId: partyCode(eater.shortcode),
        productId: productCode(labelledProduct.shortcode),
        grams: 25,
      },
      ctx.actor,
    );
    await saveMealFood(
      ctx.db,
      {
        sourceKind: "manual",
        mealId: mealCode(targetMeal.shortcode),
        ledgerPartyId: partyCode(eater.shortcode),
        name: "Manual garnish",
        grams: null,
        nutrients: { kcal: 20, protein: 0, fat: 1 },
      },
      ctx.actor,
    );

    const [portion] = await getDb(ctx.db)
      .select({ confirmedAt: mealRecipePortion.confirmedAt })
      .from(mealRecipePortion)
      .where(eq(mealRecipePortion.mealRecipeId, occurrence.id));
    expect(portion?.confirmedAt).toBeNull();

    const day = await getMealNutrition(ctx.db, { date: "2026-09-14" }, noUsda);
    expect(day.meals).toHaveLength(2);
    expect(day.people).toHaveLength(1);
    const person = day.people[0]!;
    expect(person.foods.map((food) => food.sourceKind).sort()).toEqual([
      "manual",
      "product",
      "recipe",
    ]);
    expect(
      person.foods.filter((food) => food.sourceKind === "recipe"),
    ).toHaveLength(1);
    const leftover = person.foods.find((food) => food.sourceKind === "recipe");
    expect(leftover).toMatchObject({
      meal: { id: mealCode(targetMeal.shortcode) },
      sourceMealId: mealCode(sourceMeal.shortcode),
      grams: 100,
      totals: {
        nutrition: {
          kcal: { status: "complete", lower: 100 },
          protein: { status: "complete", lower: 10 },
          carbs: { status: "complete", lower: 5 },
          fat: { status: "complete", lower: 2.5 },
        },
      },
    });
    const manual = person.foods.find((food) => food.sourceKind === "manual");
    expect(manual?.totals.nutrition.protein).toMatchObject({
      status: "complete",
      lower: 0,
    });
    expect(manual?.totals.nutrition.carbs).toEqual({
      status: "unavailable",
      reason: "no_data",
    });
    expect(person.totals.nutrition).toMatchObject({
      kcal: { status: "complete", lower: 170 },
      protein: { status: "complete", lower: 15 },
      carbs: { status: "partial", lower: 15 },
      fat: { status: "complete", lower: 6 },
    });
    expect(person.meals).toMatchObject([
      {
        meal: { id: mealCode(sourceMeal.shortcode) },
        totals: {
          nutrition: {
            kcal: { status: "complete", lower: 50 },
            protein: { status: "complete", lower: 5 },
            carbs: { status: "complete", lower: 10 },
            fat: { status: "complete", lower: 2.5 },
          },
        },
      },
      {
        meal: { id: mealCode(targetMeal.shortcode) },
        totals: {
          nutrition: {
            kcal: { status: "complete", lower: 120 },
            protein: { status: "complete", lower: 10 },
            carbs: { status: "partial", lower: 5 },
            fat: { status: "complete", lower: 3.5 },
          },
        },
      },
    ]);
    expect(aggregateTotals(person.meals.map(({ totals }) => totals))).toEqual(
      person.totals,
    );

    const target = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(targetMeal.shortcode) },
      noUsda,
    );
    expect(target.people[0]?.foods).toHaveLength(2);
    expect(target.people[0]?.totals.nutrition).toMatchObject({
      kcal: { status: "complete", lower: 120 },
      protein: { status: "complete", lower: 10 },
      carbs: { status: "partial", lower: 5 },
      fat: { status: "complete", lower: 3.5 },
    });
  });

  it("edits and removes the same food entry without leaving stale intake", async () => {
    const [meal, eater] = await Promise.all([
      seedMeal("2026-09-15", "Editable meal"),
      seedParty("Editing eater"),
    ]);
    const created = await saveMealFood(
      ctx.db,
      {
        sourceKind: "manual",
        mealId: mealCode(meal.shortcode),
        ledgerPartyId: partyCode(eater.shortcode),
        name: "Editable snack",
        grams: 30,
        nutrients: { kcal: 10, protein: 0 },
      },
      ctx.actor,
    );
    const edited = await saveMealFood(
      ctx.db,
      {
        id: created.id,
        sourceKind: "manual",
        mealId: mealCode(meal.shortcode),
        ledgerPartyId: partyCode(eater.shortcode),
        name: "Corrected snack",
        grams: null,
        nutrients: { kcal: 35, protein: 2 },
      },
      ctx.actor,
    );
    expect(edited.id).toBe(created.id);
    const afterEdit = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(meal.shortcode) },
      noUsda,
    );
    expect(afterEdit.people[0]?.foods).toEqual([
      expect.objectContaining({
        id: created.id,
        name: "Corrected snack",
        grams: null,
        totals: expect.objectContaining({
          nutrition: expect.objectContaining({
            kcal: expect.objectContaining({ lower: 35 }),
          }),
        }),
      }),
    ]);

    await removeMealFood(
      ctx.db,
      { mealId: mealCode(meal.shortcode), id: created.id },
      ctx.actor,
    );
    const afterRemove = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(meal.shortcode) },
      noUsda,
    );
    expect(afterRemove.meals).toHaveLength(1);
    expect(afterRemove.people).toEqual([]);
    await expect(
      removeMealFood(
        ctx.db,
        { mealId: mealCode(meal.shortcode), id: created.id },
        ctx.actor,
      ),
    ).rejects.toThrow("no longer available");
  });

  it("recalculates corrected product nutrition while preserving recorded grams", async () => {
    const [meal, eater, labelledProduct] = await Promise.all([
      seedMeal("2026-09-16", "Correction meal"),
      seedParty("Correction eater"),
      seedProduct("Corrected label product", { kcal: 100, protein: 10 }),
    ]);
    const saved = await saveMealFood(
      ctx.db,
      {
        sourceKind: "product",
        mealId: mealCode(meal.shortcode),
        ledgerPartyId: partyCode(eater.shortcode),
        productId: productCode(labelledProduct.shortcode),
        grams: 25,
      },
      ctx.actor,
    );
    const before = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(meal.shortcode) },
      noUsda,
    );
    expect(before.people[0]?.foods[0]).toMatchObject({
      grams: 25,
      totals: { nutrition: { kcal: { lower: 50 } } },
    });

    await getDb(ctx.db)
      .update(product)
      .set({
        labelNutrition: {
          servingGrams: 50,
          nutrients: { kcal: 200, protein: 20 },
          source: "Corrected synthetic package label",
        },
      })
      .where(eq(product.id, labelledProduct.id));
    const after = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(meal.shortcode) },
      noUsda,
    );
    expect(after.people[0]?.foods[0]).toMatchObject({
      grams: 25,
      totals: { nutrition: { kcal: { lower: 100 } } },
    });
    const stored = await getDb(ctx.db).query.mealFoodEntry.findFirst({
      where: eq(mealFoodEntry.id, saved.id),
      columns: { grams: true },
    });
    expect(stored?.grams).toBe(25);
  });

  it("keeps a stale product entry visible with unavailable nutrition and refuses new saves to the deleted source", async () => {
    const [meal, eater, labelledProduct] = await Promise.all([
      seedMeal("2026-09-17", "Stale source meal"),
      seedParty("Stale source eater"),
      seedProduct("Deleted source product", { kcal: 80 }),
    ]);
    const input = {
      sourceKind: "product" as const,
      mealId: mealCode(meal.shortcode),
      ledgerPartyId: partyCode(eater.shortcode),
      productId: productCode(labelledProduct.shortcode),
      grams: 40,
    };
    const saved = await saveMealFood(ctx.db, input, ctx.actor);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, labelledProduct.id));

    const summary = await getMealNutrition(
      ctx.db,
      { mealId: mealCode(meal.shortcode) },
      noUsda,
    );
    expect(summary.people[0]?.foods).toEqual([
      expect.objectContaining({
        id: saved.id,
        productId: productCode(labelledProduct.shortcode),
        name: "Deleted source product",
        grams: 40,
        totals: expect.objectContaining({
          nutrition: expect.objectContaining({
            kcal: { status: "unavailable", reason: "no_data" },
          }),
        }),
      }),
    ]);
    await expect(saveMealFood(ctx.db, input, ctx.actor)).rejects.toThrow(
      "not found",
    );

    const liveEntries = await getDb(ctx.db)
      .select({ id: mealFoodEntry.id })
      .from(mealFoodEntry)
      .where(
        and(eq(mealFoodEntry.mealId, meal.id), isNull(mealFoodEntry.deletedAt)),
      );
    expect(liveEntries).toHaveLength(1);
  });
});
