import { type MealCreateInput, mealCreateInput } from "@cubby/schemas/meal";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, recipe } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createLedgerParty } from "./ledger-party";
import { createMealWithEntityId } from "./meal/crud";
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

describe("meal recipe preparations", () => {
  const ctx = withTestDb();
  const createTestMeal = async (data: MealCreateInput) =>
    (await createMealWithEntityId(ctx.db, data, ctx.actor)).output;

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

    const [sourceRead, targetRead, inventoryAfter] = await Promise.all([
      getMealPreparations(ctx.db, { mealId: source.id }),
      getMealPreparations(ctx.db, { mealId: target.id }),
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
      calories: { status: "complete", lower: 160, upper: null },
    });
    expect(targetRead.totals.confirmed).toMatchObject({
      portionCount: 1,
      calories: { status: "complete", lower: 240, upper: null },
    });
    expect(inventoryAfter?.amount).toEqual(inventoryBefore.amount);
    expect(inventoryAfter?.deletedAt).toBeNull();
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
});
