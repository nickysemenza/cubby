import {
  type MealCreateInput,
  mealCreateInput,
  shoppingListInput,
} from "@cubby/schemas/meal";
import {
  buildNutrition,
  hasKnownEstimate,
  type NutritionEstimate,
} from "@cubby/schemas/nutrition";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, recipe } from "~/server/db/schema";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  getMealPreparationsWorkflow,
  getShoppingListWorkflow,
  saveMealRecipePreparationWorkflow,
} from "~/server/workflows/meal.server";

import { getDb } from "./database-helpers";
import { createLedgerParty } from "./ledger-party";
import {
  addRecipeToMeal,
  createMealWithEntityId,
  getMealsByDateRange,
  getUpcomingMealSummary,
} from "./meal/crud";
import {
  getMealPreparations,
  saveMealRecipePreparation,
} from "./meal/portions";
import {
  createRecipeFixture,
  ingredientRef,
  makeRecipeInput,
  seedIngredientWithStock,
} from "./repo.fixtures";

type MealPreparationsResult = Awaited<ReturnType<typeof getMealPreparations>>;

const requirePortionForMeal = (
  result: MealPreparationsResult,
  targetMealId: string,
) => {
  const portion = result.preparations
    .flatMap((preparation) => preparation.portions)
    .find((candidate) => candidate.targetMeal.id === targetMealId);
  if (!portion) throw new Error("expected portion for target meal");
  return portion;
};

const expectNutritionScaled = (
  before: NutritionEstimate,
  after: NutritionEstimate,
  multiplier: number,
) => {
  for (const key of TIER1_NUTRIENT_KEYS) {
    const beforeEstimate = before[key];
    const afterEstimate = after[key];
    if (!hasKnownEstimate(beforeEstimate) || !hasKnownEstimate(afterEstimate)) {
      throw new Error(`expected known ${key} estimate`);
    }
    expect(afterEstimate.lower).toBeCloseTo(beforeEstimate.lower * multiplier);
  }
};

describe("meal recipe preparations", () => {
  const ctx = withTestDb();
  const recipeTotals = (multiplier = 1) => ({
    cost: {
      status: "complete" as const,
      lower: 10 * multiplier,
      upper: null,
      coverage: { covered: 1, total: 1 },
    },
    nutrition: buildNutrition((key) => ({
      status: "complete",
      lower:
        (key === "kcal"
          ? 800
          : key === "protein"
            ? 80
            : TIER1_NUTRIENT_KEYS.indexOf(key) + 1) * multiplier,
      upper: null,
      coverage: { covered: 1, total: 1 },
    })),
  });
  const createTestMeal = async (data: MealCreateInput) =>
    (await createMealWithEntityId(ctx.db, data, ctx.actor)).output;

  it("keeps the compact Home totals equal to the full Meal read", async () => {
    const included = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic lunch" }),
      ctx.actor,
    );
    const removed = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic retired side" }),
      ctx.actor,
    );
    await createTestMeal(
      mealCreateInput.parse({
        date: "2026-09-24",
        name: "Synthetic lunch plan",
        recipes: [
          { recipeId: included.id, scale: 2 },
          { recipeId: removed.id, scale: 1 },
        ],
      }),
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: recipeTotals(), totalsComputedAt: new Date() })
      .where(eq(recipe.id, included.entityId));
    await getDb(ctx.db)
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(eq(recipe.id, removed.entityId));

    const [full] = await getMealsByDateRange(
      ctx.db,
      "2026-09-24",
      "2026-09-24",
    );
    const [summary] = await getUpcomingMealSummary(
      ctx.db,
      "2026-09-24",
      "2026-09-24",
    );
    expect(full).toBeDefined();
    expect(summary).toEqual({
      id: full?.id,
      date: full?.date,
      name: full?.name,
      mealType: full?.mealType,
      mealKind: full?.mealKind,
      totals: full?.totals,
    });
    expect(summary?.totals.cost).toMatchObject({
      status: "complete",
      lower: 20,
    });
  });

  it("returns distinct occurrence handles for repeated recipes and preserves shopping contributions", async () => {
    const ingredient = await seedIngredientWithStock(
      ctx.db,
      { name: "Repeated serving flour", onHand: { value: 0, unit: "g" } },
      ctx.actor,
    );
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Repeated serving recipe",
        sections: [
          {
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 100, unit: "g" }],
              }),
            ],
            instructions: [{ instruction: "Cook" }],
          },
        ],
      }),
      ctx.actor,
    );
    const source = await createMealWithEntityId(
      ctx.db,
      mealCreateInput.parse({ date: "2026-09-21", name: "Two servings" }),
      ctx.actor,
    );
    const first = await addRecipeToMeal(
      ctx.db,
      source.entityId,
      { recipeId: recipeFixture.id, scale: 1, sortOrder: 0 },
      ctx.actor,
    );
    const second = await addRecipeToMeal(
      ctx.db,
      source.entityId,
      { recipeId: recipeFixture.id, scale: 2, sortOrder: 1 },
      ctx.actor,
    );
    expect(first.mealRecipeId).not.toBe(second.mealRecipeId);
    expect(second.meal.recipes).toEqual([
      expect.objectContaining({ id: first.mealRecipeId, scale: 1 }),
      expect.objectContaining({ id: second.mealRecipeId, scale: 2 }),
    ]);

    // The returned handle targets the inserted occurrence without another read.
    await saveMealRecipePreparation(
      ctx.db,
      { mealRecipeId: second.mealRecipeId, actualYieldGrams: 200, changes: [] },
      ctx.actor,
    );
    const preparations = await getMealPreparationsWorkflow(
      ctx.db,
      { mealId: source.output.id },
      createTestRequestContext(ctx.db).services.recipeCosting,
    );
    expect(preparations.preparations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mealRecipeId: second.mealRecipeId,
          actualYieldGrams: 200,
        }),
      ]),
    );
    const shopping = await getShoppingListWorkflow(
      ctx.db,
      shoppingListInput.parse({ from: "2026-09-21", to: "2026-09-21" }),
      createTestRequestContext(ctx.db).services.availability,
    );
    expect(shopping.items).toEqual([
      expect.objectContaining({
        ingredientId: ingredient.shortcode,
        needValue: 300,
        perMeal: [
          expect.objectContaining({ lineIndex: 0, scale: 1, needValue: 100 }),
          expect.objectContaining({ lineIndex: 1, scale: 2, needValue: 200 }),
        ],
      }),
    ]);
  });

  it("commits portions atomically without auto-decrementing inventory", async () => {
    const ingredient = await seedIngredientWithStock(
      ctx.db,
      { name: "meal preparation flour", onHand: { value: 500, unit: "g" } },
      ctx.actor,
    );
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Test braise",
        sections: [
          {
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
            instructions: [{ instruction: "Cook" }],
          },
        ],
      }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({
        yield: { value: 400, unit: "g" },
        totals: recipeTotals(),
        totalsComputedAt: new Date(),
      })
      .where(eq(recipe.id, recipeFixture.entityId));
    const inventoryBefore = await getDb(
      ctx.db,
    ).query.inventoryEntry.findFirst();
    if (!inventoryBefore) throw new Error("fixture setup failed");

    const [source, target, eater] = await Promise.all([
      createTestMeal(
        mealCreateInput.parse({
          date: "2026-08-31",
          name: "Cook night",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
      ),
      createTestMeal(
        mealCreateInput.parse({ date: "2026-09-01", name: "Leftovers" }),
      ),
      createLedgerParty(
        ctx.db,
        { name: "Test eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");

    await saveMealRecipePreparationWorkflow(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        estimatedYieldGrams: 450,
        actualYieldGrams: 500,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: eater.output.id,
            amount: { value: 100, unit: "g" },
            confirmed: true,
          },
          {
            action: "set",
            mealId: target.id,
            ledgerPartyId: eater.output.id,
            amount: { value: 150, unit: "g" },
            confirmed: true,
          },
        ],
      },
      ctx.actor,
    );

    const [sourceRead, targetRead, inventoryAfter] = await Promise.all([
      getMealPreparationsWorkflow(ctx.db, { mealId: source.id }),
      getMealPreparationsWorkflow(ctx.db, { mealId: target.id }),
      getDb(ctx.db).query.inventoryEntry.findFirst({
        where: eq(inventoryEntry.id, inventoryBefore.id),
      }),
    ]);

    expect(sourceRead.preparations).toHaveLength(1);
    expect(sourceRead.preparations[0]?.sourceSummary).toMatchObject({
      assignedGrams: 250,
      confirmedGrams: 250,
      unassignedGrams: 250,
    });
    expect(sourceRead.totals.confirmed).toMatchObject({
      portionCount: 1,
      totals: {
        cost: { status: "complete", lower: 2, upper: null },
        nutrition: {
          kcal: { status: "complete", lower: 160, upper: null },
          protein: { status: "complete", lower: 16, upper: null },
        },
      },
    });
    expect(targetRead.totals.confirmed).toMatchObject({
      portionCount: 1,
      totals: {
        cost: { status: "complete", lower: 3, upper: null },
        nutrition: {
          kcal: { status: "complete", lower: 240, upper: null },
          protein: { status: "complete", lower: 24, upper: null },
        },
      },
    });
    expect(inventoryAfter?.amount).toEqual(inventoryBefore.amount);
    expect(inventoryAfter?.deletedAt).toBeNull();

    const recorded = requirePortionForMeal(sourceRead, source.id);
    const recordedFacts = {
      grams: recorded.grams,
      targetDate: recorded.targetMeal.date,
      confirmedAt: recorded.confirmedAt,
    };

    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: recipeTotals(2), totalsComputedAt: new Date() })
      .where(eq(recipe.id, recipeFixture.entityId));
    const corrected = await getMealPreparations(ctx.db, {
      mealId: source.id,
    });
    const correctedPortion = requirePortionForMeal(corrected, source.id);
    expect({
      grams: correctedPortion.grams,
      targetDate: correctedPortion.targetMeal.date,
      confirmedAt: correctedPortion.confirmedAt,
    }).toEqual(recordedFacts);
    expectNutritionScaled(
      recorded.totals.nutrition,
      correctedPortion.totals.nutrition,
      2,
    );

    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: null, totalsComputedAt: null })
      .where(eq(recipe.id, recipeFixture.entityId));
    const pending = await getMealPreparations(ctx.db, { mealId: source.id });
    const pendingPortion = requirePortionForMeal(pending, source.id);
    expect(pendingPortion.totals.cost).toEqual({
      status: "pending",
      reason: "totals_missing",
    });
    expect(pendingPortion.totals.nutrition.kcal).toEqual({
      status: "pending",
      reason: "totals_missing",
    });

    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: recipeTotals(3), totalsComputedAt: new Date() })
      .where(eq(recipe.id, recipeFixture.entityId));
    const regenerated = await getMealPreparations(ctx.db, {
      mealId: source.id,
    });
    const regeneratedPortion = requirePortionForMeal(regenerated, source.id);
    expect(regeneratedPortion.totals.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 480,
    });
    expect({
      grams: regeneratedPortion.grams,
      targetDate: regeneratedPortion.targetMeal.date,
      confirmedAt: regeneratedPortion.confirmedAt,
    }).toEqual(recordedFacts);
  });

  it("rejects invalid portions without committing a partial preparation", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Preparation constraints" }),
      ctx.actor,
    );
    const [source, member, household] = await Promise.all([
      createTestMeal(
        mealCreateInput.parse({
          date: "2026-09-08",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
      ),
      createLedgerParty(
        ctx.db,
        { name: "Constraint member", kind: "member", notes: null },
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Constraint household", kind: "household", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !member.output || !household.output)
      throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        actualYieldGrams: 100,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: member.output.id,
            amount: { value: 100, unit: "g" },
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );

    await expect(
      saveMealRecipePreparation(
        ctx.db,
        {
          mealRecipeId: occurrence.id,
          actualYieldGrams: 50,
          changes: [
            {
              action: "set",
              mealId: source.id,
              ledgerPartyId: member.output.id,
              amount: { value: 100, unit: "g" },
              confirmed: false,
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("exceed the actual cooked yield");
    await expect(
      saveMealRecipePreparation(
        ctx.db,
        {
          mealRecipeId: occurrence.id,
          changes: [
            {
              action: "set",
              mealId: source.id,
              ledgerPartyId: household.output.id,
              amount: { value: 1, unit: "g" },
              confirmed: false,
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("household ledger party");

    const read = await getMealPreparations(ctx.db, { mealId: source.id });
    expect(read.preparations[0]).toMatchObject({ actualYieldGrams: 100 });
    expect(read.preparations[0]?.portions).toHaveLength(1);
  });
});
