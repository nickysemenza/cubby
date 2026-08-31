import { type MealCreateInput, mealCreateInput } from "@cubby/schemas/meal";
import { recipeTotals } from "@cubby/schemas/recipe-shared";
import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mealRecipePortion, recipe } from "~/server/db/schema";

import { deleteCookbook, upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import { upsertCookbookRecipeFromCookbook } from "./import-recipe-convert";
import {
  createLedgerParty,
  deleteLedgerParties,
  mergeLedgerParties,
} from "./ledger-party";
import {
  createMeal,
  deleteMeals,
  getMealsByDateRange,
  getUpcomingMealSummary,
  mealList,
} from "./meal";
import {
  aggregateMealPreparationCalories,
  batchCaloriesFor,
  getMealPreparations,
  saveMealRecipePreparation,
  yieldBasisFor,
} from "./meal/portions";
import { deleteRecipes, getRecipeByID } from "./recipe";
import {
  cookbookRecipe,
  createRecipeFixture,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveOrThrow } from "./shortcode-resolver";

const pagination = { pageIndex: 0, pageSize: 50 };

describe("meal recipe preparations", () => {
  const ctx = withTestDb();

  it("assigns a preparation across meals without counting a self-targeted portion twice", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Test braise" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({
        yield: { value: 400, unit: "g" },
        totals: {
          costTotal: 0,
          caloriesTotal: 800,
          ingredientCount: 1,
          costCovered: 1,
          caloriesCovered: 1,
        },
        totalsComputedAt: new Date(),
      })
      .where(eq(recipe.id, recipeFixture.entityId));

    const [source, target, eater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-08-31",
          name: "Cook night",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-09-01", name: "Leftovers" }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Test eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");

    await saveMealRecipePreparation(
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
            grams: 100,
            confirmed: true,
          },
          {
            action: "set",
            mealId: target.id,
            ledgerPartyId: eater.output.id,
            grams: 150,
            confirmed: true,
          },
        ],
      },
      ctx.actor,
    );

    const [sourceRead, targetRead] = await Promise.all([
      getMealPreparations(ctx.db, { mealId: source.id }),
      getMealPreparations(ctx.db, { mealId: target.id }),
    ]);

    expect(sourceRead.preparations).toHaveLength(1);
    expect(sourceRead.preparations[0]?.sourceSummary).toMatchObject({
      assignedGrams: 250,
      confirmedGrams: 250,
      unassignedGrams: 250,
    });
    expect(sourceRead.totals.confirmed).toMatchObject({
      portionCount: 1,
      calories: { status: "complete", lower: 160, upper: null },
    });
    expect(targetRead.totals.confirmed).toMatchObject({
      portionCount: 1,
      calories: { status: "complete", lower: 240, upper: null },
    });
  });

  it("preserves confirmation time, tombstones removal, and creates a fresh portion when set again", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Preparation lifecycle" }),
      ctx.actor,
    );
    const [source, eater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-02",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Lifecycle eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");
    const set = (grams: number) =>
      saveMealRecipePreparation(
        ctx.db,
        {
          mealRecipeId: occurrence.id,
          changes: [
            {
              action: "set",
              mealId: source.id,
              ledgerPartyId: eater.output.id,
              grams,
              confirmed: true,
            },
          ],
        },
        ctx.actor,
      );

    await set(100);
    const [original] = await getDb(ctx.db)
      .select({
        id: mealRecipePortion.id,
        confirmedAt: mealRecipePortion.confirmedAt,
      })
      .from(mealRecipePortion)
      .where(eq(mealRecipePortion.mealRecipeId, occurrence.id));
    expect(original?.confirmedAt).not.toBeNull();
    await set(120);
    const [corrected] = await getDb(ctx.db)
      .select({
        id: mealRecipePortion.id,
        confirmedAt: mealRecipePortion.confirmedAt,
      })
      .from(mealRecipePortion)
      .where(
        and(
          eq(mealRecipePortion.mealRecipeId, occurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      );
    expect(corrected).toEqual(original);

    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        changes: [
          {
            action: "remove",
            mealId: source.id,
            ledgerPartyId: eater.output.id,
          },
        ],
      },
      ctx.actor,
    );
    await set(130);
    const portions = await getDb(ctx.db)
      .select({
        id: mealRecipePortion.id,
        deletedAt: mealRecipePortion.deletedAt,
      })
      .from(mealRecipePortion)
      .where(eq(mealRecipePortion.mealRecipeId, occurrence.id));
    expect(portions).toHaveLength(2);
    expect(
      portions.filter((portion) => portion.deletedAt == null),
    ).toHaveLength(1);
    expect(portions.find((portion) => portion.deletedAt != null)?.id).toBe(
      original?.id,
    );
  });

  it("allows an actual-yield reduction when the same atomic save removes capacity", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Atomic yield" }),
      ctx.actor,
    );
    const [source, target, eater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-03",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-09-04" }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Atomic eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        actualYieldGrams: 500,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: eater.output.id,
            grams: 200,
            confirmed: false,
          },
          {
            action: "set",
            mealId: target.id,
            ledgerPartyId: eater.output.id,
            grams: 300,
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
          actualYieldGrams: 250,
          changes: [
            {
              action: "remove",
              mealId: target.id,
              ledgerPartyId: eater.output.id,
            },
          ],
        },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ actualYieldGrams: 250 });
  });

  it("rejects over-allocation and household eaters without committing a partial preparation", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Preparation constraints" }),
      ctx.actor,
    );
    const [source, member, household] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-08",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
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
            grams: 100,
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
              grams: 100,
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
              grams: 1,
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

  it("uses the conservative formula for ranged calories and nominal mass yield", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Ranged preparation" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({
        yield: { value: 400, upperValue: 500, unit: "g" },
        totals: {
          costTotal: 0,
          caloriesTotal: 800,
          caloriesTotalUpper: 1000,
          ingredientCount: 1,
          costCovered: 1,
          caloriesCovered: 1,
        },
        totalsComputedAt: new Date(),
      })
      .where(eq(recipe.id, recipeFixture.entityId));
    const [source, eater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-05",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Range eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: eater.output.id,
            grams: 100,
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    const read = await getMealPreparations(ctx.db, { mealId: source.id });
    expect(read.preparations[0]?.yieldBasis).toEqual({
      kind: "recipe",
      lowerGrams: 400,
      upperGrams: 500,
    });
    expect(read.preparations[0]?.portions[0]?.calories).toEqual({
      status: "complete",
      lower: 160,
      upper: 250,
    });
    await getDb(ctx.db)
      .update(recipe)
      .set({
        totals: {
          costTotal: 0,
          caloriesTotal: 1000,
          caloriesTotalUpper: 1200,
          ingredientCount: 1,
          costCovered: 1,
          caloriesCovered: 1,
        },
        totalsComputedAt: new Date(),
      })
      .where(eq(recipe.id, recipeFixture.entityId));
    const corrected = await getMealPreparations(ctx.db, { mealId: source.id });
    expect(corrected.preparations[0]?.portions[0]?.calories).toEqual({
      status: "complete",
      lower: 200,
      upper: 300,
    });
  });

  it("serializes concurrent portion assignments against the actual yield", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Concurrent preparation" }),
      ctx.actor,
    );
    const [source, firstEater, secondEater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-08",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Member A", kind: "member", notes: null },
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Member B", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !firstEater.output || !secondEater.output)
      throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        actualYieldGrams: 100,
        changes: [],
      },
      ctx.actor,
    );

    const results = await Promise.allSettled(
      [firstEater.output.id, secondEater.output.id].map((ledgerPartyId) =>
        saveMealRecipePreparation(
          ctx.db,
          {
            mealRecipeId: occurrence.id,
            changes: [
              {
                action: "set",
                mealId: source.id,
                ledgerPartyId,
                grams: 60,
                confirmed: false,
              },
            ],
          },
          ctx.actor,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const read = await getMealPreparations(ctx.db, { mealId: source.id });
    expect(read.preparations[0]?.sourceSummary?.assignedGrams).toBe(60);
  });

  it("keeps repeated recipe occurrences and different recipes as independent preparations", async () => {
    const [sharedRecipe, otherRecipe, target, eater] = await Promise.all([
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Repeated" }),
        ctx.actor,
      ),
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Other" }),
        ctx.actor,
      ),
      createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-09-09" }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Independent eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const source = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-09-10",
        recipes: [
          { recipeId: sharedRecipe.id, scale: 1 },
          { recipeId: sharedRecipe.id, scale: 2 },
          { recipeId: otherRecipe.id, scale: 1 },
        ],
      }),
      ctx.actor,
    );
    if (!eater.output || source.recipes.length !== 3)
      throw new Error("fixture setup failed");
    const actualYields = [100, 200, 300] as const;
    const portionGrams = [50, 100, 80] as const;
    await Promise.all(
      source.recipes.map((occurrence, index) => {
        const actualYieldGrams = actualYields[index];
        const grams = portionGrams[index];
        if (actualYieldGrams === undefined || grams === undefined)
          throw new Error("fixture setup failed");
        return saveMealRecipePreparation(
          ctx.db,
          {
            mealRecipeId: occurrence.id,
            actualYieldGrams,
            changes: [
              {
                action: "set",
                mealId: target.id,
                ledgerPartyId: eater.output.id,
                grams,
                confirmed: false,
              },
            ],
          },
          ctx.actor,
        );
      }),
    );
    const read = await getMealPreparations(ctx.db, { mealId: target.id });
    expect(read.preparations).toHaveLength(3);
    expect(
      read.preparations.map((preparation) => ({
        mealRecipeId: preparation.mealRecipeId,
        actualYieldGrams: preparation.actualYieldGrams,
        grams: preparation.portions[0]?.grams,
      })),
    ).toEqual(
      expect.arrayContaining(
        source.recipes.map((occurrence, index) => ({
          mealRecipeId: occurrence.id,
          actualYieldGrams: [100, 200, 300][index],
          grams: [50, 100, 80][index],
        })),
      ),
    );
  });

  it("soft-deletes portions from target meals, source meals, recipes, and cookbooks", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Cascade recipe" }),
      ctx.actor,
    );
    const [source, target, eater] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-11",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-09-12" }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Cascade eater", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !eater.output) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: eater.output.id,
            grams: 10,
            confirmed: false,
          },
          {
            action: "set",
            mealId: target.id,
            ledgerPartyId: eater.output.id,
            grams: 20,
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    await deleteMeals(
      ctx.db,
      [await resolveOrThrow(ctx.db, "meal", target.id)],
      ctx.actor,
    );
    expect(
      await getDb(ctx.db).query.mealRecipePortion.findMany({
        where: and(
          eq(mealRecipePortion.mealRecipeId, occurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      }),
    ).toHaveLength(1);
    await deleteMeals(
      ctx.db,
      [await resolveOrThrow(ctx.db, "meal", source.id)],
      ctx.actor,
    );
    expect(
      await getDb(ctx.db).query.mealRecipePortion.findMany({
        where: and(
          eq(mealRecipePortion.mealRecipeId, occurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      }),
    ).toHaveLength(0);

    const recipeDelete = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Recipe delete cascade" }),
      ctx.actor,
    );
    const recipeMeal = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-09-13",
        recipes: [{ recipeId: recipeDelete.id, scale: 1 }],
      }),
      ctx.actor,
    );
    const recipeOccurrence = recipeMeal.recipes[0];
    if (!recipeOccurrence) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: recipeOccurrence.id,
        changes: [
          {
            action: "set",
            mealId: recipeMeal.id,
            ledgerPartyId: eater.output.id,
            grams: 10,
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    await deleteRecipes(ctx.db, [recipeDelete.entityId], ctx.actor);
    expect(
      await getDb(ctx.db).query.mealRecipePortion.findMany({
        where: and(
          eq(mealRecipePortion.mealRecipeId, recipeOccurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      }),
    ).toHaveLength(0);

    const raw = cookbookRecipe("Cookbook cascade", ["1 g salt"]);
    const cookbook = await upsertCookbook(
      ctx.db,
      { name: "Cascade cookbook", rawJson: [raw], sourceLabel: "test" },
      ctx.actor,
    );
    const importedCookbookRecipe = await upsertCookbookRecipeFromCookbook(
      raw,
      { id: cookbook.entityId, name: "Cascade cookbook" },
      ctx.db,
      ctx.actor,
    );
    const bookRecipe = await getRecipeByID(ctx.db, importedCookbookRecipe.id);
    if (!bookRecipe) throw new Error("fixture setup failed");
    const cookbookMeal = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-09-14",
        recipes: [{ recipeId: bookRecipe.id, scale: 1 }],
      }),
      ctx.actor,
    );
    const cookbookOccurrence = cookbookMeal.recipes[0];
    if (!cookbookOccurrence) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: cookbookOccurrence.id,
        changes: [
          {
            action: "set",
            mealId: cookbookMeal.id,
            ledgerPartyId: eater.output.id,
            grams: 10,
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    await deleteCookbook(ctx.db, cookbook.entityId, ctx.actor);
    expect(
      await getDb(ctx.db).query.mealRecipePortion.findMany({
        where: and(
          eq(mealRecipePortion.mealRecipeId, cookbookOccurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      }),
    ).toHaveLength(0);
  });

  it("keeps known calories as a partial lower bound when other portions are unavailable or partial", () => {
    expect(
      aggregateMealPreparationCalories([
        { status: "complete", lower: 120, upper: null },
        { status: "unavailable", reason: "yield_missing" },
      ]),
    ).toEqual({ status: "partial", lower: 120 });
    expect(
      aggregateMealPreparationCalories([
        { status: "complete", lower: 120, upper: null },
        { status: "partial", lower: 80 },
      ]),
    ).toEqual({ status: "partial", lower: 200 });
    expect(
      aggregateMealPreparationCalories([
        { status: "complete", lower: 100, upper: null },
        { status: "complete", lower: 200, upper: 250 },
      ]),
    ).toEqual({ status: "complete", lower: 300, upper: 350 });
  });

  it("prefers actual, then estimated, then nominal mass yield and surfaces stale and partial nutrition", () => {
    const nominal = { value: 200, unit: "g" };
    expect(yieldBasisFor(500, 400, nominal, 2)).toMatchObject({
      kind: "actual",
      lowerGrams: 500,
    });
    expect(yieldBasisFor(null, 400, nominal, 2)).toMatchObject({
      kind: "estimated",
      lowerGrams: 400,
    });
    expect(yieldBasisFor(null, null, nominal, 2)).toEqual({
      kind: "recipe",
      lowerGrams: 400,
      upperGrams: null,
    });
    expect(yieldBasisFor(null, null, null, 1)).toEqual({
      kind: "missing",
      lowerGrams: null,
      upperGrams: null,
    });
    const totals = recipeTotals.parse({
      costTotal: 0,
      caloriesTotal: 600,
      ingredientCount: 2,
      costCovered: 2,
      caloriesCovered: 1,
    });
    expect(batchCaloriesFor(totals, null, 1)).toEqual({
      status: "pending",
      reason: "totals_stale",
    });
    expect(batchCaloriesFor(totals, new Date(), 1)).toEqual({
      status: "partial",
      lower: 600,
    });
  });

  it("blocks portion-eater deletion and folds merged eater collisions without confirming mixed rows", async () => {
    const recipeFixture = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Merged eaters" }),
      ctx.actor,
    );
    const [source, target, keep, lose] = await Promise.all([
      createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-06",
          recipes: [{ recipeId: recipeFixture.id, scale: 1 }],
        }),
        ctx.actor,
      ),
      createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-09-07" }),
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Merge keeper", kind: "member", notes: null },
        ctx.actor,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Merge loser", kind: "member", notes: null },
        ctx.actor,
      ),
    ]);
    const occurrence = source.recipes[0];
    if (!occurrence || !keep.output || !lose.output)
      throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        changes: [
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: keep.output.id,
            grams: 100,
            confirmed: true,
          },
          {
            action: "set",
            mealId: source.id,
            ledgerPartyId: lose.output.id,
            grams: 50,
            confirmed: false,
          },
          {
            action: "set",
            mealId: target.id,
            ledgerPartyId: lose.output.id,
            grams: 25,
            confirmed: true,
          },
        ],
      },
      ctx.actor,
    );
    await expect(
      deleteLedgerParties(ctx.db, [lose.output.id], ctx.actor),
    ).rejects.toThrow("meal portions");
    const merged = await mergeLedgerParties(
      ctx.db,
      { keepId: keep.output.id, mergeIds: [lose.output.id] },
      ctx.actor,
    );
    expect(merged.mergeSummary.portionEdgesRepointed).toBe(2);
    const portions = await getDb(ctx.db)
      .select({
        mealId: mealRecipePortion.mealId,
        ledgerPartyId: mealRecipePortion.ledgerPartyId,
        grams: mealRecipePortion.grams,
        confirmedAt: mealRecipePortion.confirmedAt,
      })
      .from(mealRecipePortion)
      .where(
        and(
          eq(mealRecipePortion.mealRecipeId, occurrence.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      );
    expect(portions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ledgerPartyId: keep.entityId,
          grams: 150,
          confirmedAt: null,
        }),
        expect.objectContaining({
          ledgerPartyId: keep.entityId,
          grams: 25,
          confirmedAt: expect.any(Date),
        }),
      ]),
    );
  });
});

describe("getUpcomingMealSummary", () => {
  const ctx = withTestDb();

  it("matches the canonical date-range results while returning at most four rows", async () => {
    for (let day = 1; day <= 6; day += 1) {
      await createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: `2026-06-0${day}`,
          name: `summary meal ${day}`,
        }),
        ctx.actor,
      );
    }

    const canonical = await getMealsByDateRange(
      ctx.db,
      "2026-06-01",
      "2026-06-30",
    );
    const compact = await getUpcomingMealSummary(
      ctx.db,
      "2026-06-01",
      "2026-06-30",
    );

    expect(compact).toHaveLength(4);
    expect(compact).toEqual(
      canonical.slice(0, 4).map((meal) => ({
        id: meal.id,
        date: meal.date,
        name: meal.name,
        mealType: meal.mealType,
        mealKind: meal.mealKind,
        totals: meal.totals,
      })),
    );
  });
});

/**
 * `mealFilterFields` spreads `mealRelatedFilterFields` (the recipe trio) and the
 * manifest renders its control, but `mealList` never called
 * `relatedWhereConditions` — so the Meals table sent a recipe filter the server
 * silently ignored and returned every meal. Same drift as #588's wish gap; found
 * by the generic guard in `filter-application.integration.test.ts`, which pins the
 * narrowing direction. These pin the other direction: that the predicate matches
 * the RIGHT meals, not merely fewer of them.
 */
describe("mealList related-recipe filters", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const planned = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Braised Short Ribs" }),
      ctx.actor,
    );
    const other = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Sheet Pan Salmon" }),
      ctx.actor,
    );
    const withPlanned = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-02-01",
        name: "Sunday dinner",
        recipes: [{ recipeId: planned.id, scale: 1 }],
      }),
      ctx.actor,
    );
    const withOther = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-02-02",
        name: "Monday dinner",
        recipes: [{ recipeId: other.id, scale: 1 }],
      }),
      ctx.actor,
    );
    return { planned, other, withPlanned, withOther };
  };

  it("narrows to the meals planning that recipe", async () => {
    const { planned, withPlanned } = await seed();
    const { data } = await mealList(
      ctx.db,
      { recipeId: planned.id },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([withPlanned.id]);
  });

  it("narrows on the related recipe search the manifest exposes", async () => {
    const { withOther } = await seed();
    const { data } = await mealList(
      ctx.db,
      { recipeSearch: "Salmon" },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([withOther.id]);
  });

  it("splits meals by whether any recipe is planned at all", async () => {
    const { withPlanned, withOther } = await seed();
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-02-03", name: "Nothing planned" }),
      ctx.actor,
    );

    const has = await mealList(
      ctx.db,
      { recipePresenceFilter: "has" },
      [],
      pagination,
    );
    expect(has.data.map((row) => row.id).sort()).toEqual(
      [withPlanned.id, withOther.id].sort(),
    );

    const none = await mealList(
      ctx.db,
      { recipePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((row) => row.name)).toEqual(["Nothing planned"]);
  });
});

describe("mealList classification filters", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const dinnerOut = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-03-01",
        name: "Anniversary",
        mealType: "dinner",
        mealKind: "eating_out",
      }),
      ctx.actor,
    );
    const dinnerCooked = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-03-02",
        name: "Roast",
        mealType: "dinner",
      }),
      ctx.actor,
    );
    const unslotted = await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-03-03", name: "Whenever" }),
      ctx.actor,
    );
    return { dinnerOut, dinnerCooked, unslotted };
  };

  it("defaults mealKind to cooked and leaves mealType null", async () => {
    const { unslotted } = await seed();
    expect(unslotted.mealKind).toBe("cooked");
    expect(unslotted.mealType).toBeNull();
  });

  it("narrows on mealType and on mealKind", async () => {
    const { dinnerOut, dinnerCooked } = await seed();

    const dinners = await mealList(
      ctx.db,
      { mealType: "dinner" },
      [],
      pagination,
    );
    expect(dinners.data.map((row) => row.id).sort()).toEqual(
      [dinnerOut.id, dinnerCooked.id].sort(),
    );

    const out = await mealList(
      ctx.db,
      { mealKind: "eating_out" },
      [],
      pagination,
    );
    expect(out.data.map((row) => row.id)).toEqual([dinnerOut.id]);
  });

  it("ORs the mealType presence sentinel with the value list", async () => {
    const { dinnerOut, dinnerCooked, unslotted } = await seed();

    const none = await mealList(
      ctx.db,
      { mealTypePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((row) => row.id)).toEqual([unslotted.id]);

    const both = await mealList(
      ctx.db,
      { mealType: "dinner", mealTypePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(both.data.map((row) => row.id).sort()).toEqual(
      [dinnerOut.id, dinnerCooked.id, unslotted.id].sort(),
    );
  });
});

describe("mealList sorting", () => {
  const ctx = withTestDb();

  const makeMeal = (date: string, overrides: Partial<MealCreateInput> = {}) =>
    createMeal(
      ctx.db,
      mealCreateInput.parse({ date, ...overrides }),
      ctx.actor,
    );

  it("sorts mealType by slot, not alphabetically", async () => {
    // The regression this pins: "dessert" < "dinner" as text, so a plain
    // column sort would put dessert first. Slot order is what the calendar
    // uses and what a reader expects.
    await makeMeal("2026-05-01", { name: "D", mealType: "dessert" });
    await makeMeal("2026-05-02", { name: "B", mealType: "breakfast" });
    await makeMeal("2026-05-03", { name: "N", mealType: "dinner" });

    const { data } = await mealList(
      ctx.db,
      {},
      [{ orderBy: "mealType", direction: "asc" }],
      pagination,
    );

    expect(data.map((row) => row.mealType)).toEqual([
      "breakfast",
      "dinner",
      "dessert",
    ]);
  });

  it("sorts unslotted meals last in both directions", async () => {
    await makeMeal("2026-05-04", { name: "Slotted", mealType: "lunch" });
    await makeMeal("2026-05-05", { name: "Unslotted" });

    for (const direction of ["asc", "desc"] as const) {
      const { data } = await mealList(
        ctx.db,
        {},
        [{ orderBy: "mealType", direction }],
        pagination,
      );
      expect(data.at(-1)?.name).toBe("Unslotted");
    }
  });

  it("orders unnamed meals by date within the name-sort NULL block", async () => {
    await makeMeal("2026-05-06");
    await makeMeal("2026-05-08");
    await makeMeal("2026-05-07");
    await makeMeal("2026-05-09", { name: "Named" });

    const { data } = await mealList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      pagination,
    );

    expect(data[0]?.name).toBe("Named");
    expect(data.slice(1).map((row) => row.date)).toEqual([
      "2026-05-08",
      "2026-05-07",
      "2026-05-06",
    ]);
  });
});
