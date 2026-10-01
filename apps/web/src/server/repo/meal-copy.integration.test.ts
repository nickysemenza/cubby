import { eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mealFoodEntry, mealRecipePortion } from "~/server/db/schema";
import {
  copyMealRangeWorkflow,
  duplicateMealWorkflow,
  saveMealRecipePreparationWorkflow,
} from "~/server/operations/meal.server";

import { getDb, notDeleted } from "./database-helpers";
import { createLedgerParty } from "./ledger-party";
import { createMealWithEntityId, getMealsByDateRange } from "./meal/crud";
import { saveMealFood } from "./meal/food";
import { createRecipeFixture, makeRecipeInput } from "./repo.fixtures";

describe("meal duplicate and copy range", () => {
  const ctx = withTestDb();
  const context = () => ({ db: ctx.db, actorContext: ctx.actor });

  // A batch cooked on the first day and eaten on both days, one confirmed
  // portion per day, plus a manual food entry and a scaled second recipe.
  const seedWeek = async () => {
    const [stew, side] = await Promise.all([
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Copy stew" }),
        ctx.actor,
      ),
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Copy side" }),
        ctx.actor,
      ),
    ]);
    const eater = await createLedgerParty(
      ctx.db,
      { name: "Copy eater", kind: "member", notes: null },
      ctx.actor,
    );
    if (!eater.output) throw new Error("fixture setup failed");
    const cook = (
      await createMealWithEntityId(
        ctx.db,
        buildEntity("meal", {
          date: "2026-03-02",
          name: "Cook night",
          mealType: "dinner",
          recipes: [
            { recipeId: stew.id, scale: 2, sortOrder: 0 },
            { recipeId: side.id, scale: 1, sortOrder: 1 },
          ],
        }),
        ctx.actor,
      )
    ).output;
    const leftovers = (
      await createMealWithEntityId(
        ctx.db,
        buildEntity("meal", { date: "2026-03-03", name: "Leftovers" }),
        ctx.actor,
      )
    ).output;
    const stewOccurrence = cook.recipes.find((row) => row.scale === 2);
    if (!stewOccurrence) throw new Error("fixture setup failed");
    await saveMealRecipePreparationWorkflow(context(), {
      mealRecipeId: stewOccurrence.id,
      actualYieldGrams: 800,
      changes: [
        {
          action: "set",
          mealId: cook.id,
          ledgerPartyId: eater.output.id,
          amount: { value: 200, unit: "g" },
          confirmed: true,
        },
        {
          action: "set",
          mealId: leftovers.id,
          ledgerPartyId: eater.output.id,
          amount: { value: 300, unit: "g" },
          confirmed: true,
        },
      ],
    });
    await saveMealFood(
      ctx.db,
      {
        sourceKind: "manual",
        mealId: leftovers.id,
        ledgerPartyId: eater.output.id,
        name: "Copy garnish",
        nutrients: { kcal: 20, protein: 0, fat: 1 },
      },
      ctx.actor,
    );
    return { cook, leftovers };
  };

  it("copies a week as planned meals sourced from the new occurrences, leaving the original untouched", async () => {
    const { cook } = await seedWeek();

    const result = await copyMealRangeWorkflow(context(), {
      from: "2026-03-02",
      to: "2026-03-08",
      targetFrom: "2026-03-09",
    });
    expect(result.mealIds).toHaveLength(2);
    expect(result.skippedPortions).toBe(0);

    const copies = await getMealsByDateRange(
      ctx.db,
      "2026-03-09",
      "2026-03-10",
    );
    expect(copies.map((row) => [row.date, row.name, row.mealType])).toEqual([
      ["2026-03-09", "Cook night", "dinner"],
      ["2026-03-10", "Leftovers", null],
    ]);
    const copiedCook = copies[0]!;
    expect(copiedCook.recipes.map((row) => row.scale)).toEqual([2, 1]);
    expect(copiedCook.recipes.map((row) => row.id)).not.toEqual(
      cook.recipes.map((row) => row.id),
    );

    const db = getDb(ctx.db);
    const live = await db
      .select()
      .from(mealRecipePortion)
      .where(notDeleted(mealRecipePortion));
    // Two original portions plus two planned copies, all live.
    expect(live).toHaveLength(4);
    const copiedOccurrenceIds = new Set(
      copiedCook.recipes.map((row) => row.id),
    );
    const planned = live.filter((row) => row.confirmedAt === null);
    expect(planned).toHaveLength(2);
    for (const portion of planned)
      expect(copiedOccurrenceIds.has(portion.mealRecipeId)).toBe(true);
    expect(live.filter((row) => row.confirmedAt !== null)).toHaveLength(2);

    const foods = await db
      .select()
      .from(mealFoodEntry)
      .where(notDeleted(mealFoodEntry));
    expect(foods.map((row) => row.name)).toEqual([
      "Copy garnish",
      "Copy garnish",
    ]);

    // Copying appends: the source week still has exactly its own two meals.
    const original = await getMealsByDateRange(
      ctx.db,
      "2026-03-02",
      "2026-03-08",
    );
    expect(original).toHaveLength(2);
  });

  it("duplicates one meal onto another day and skips portions whose batch was not copied", async () => {
    const { leftovers } = await seedWeek();

    const copy = await duplicateMealWorkflow(context(), {
      mealId: leftovers.id,
      date: "2026-03-20",
    });
    const [created] = await getMealsByDateRange(
      ctx.db,
      "2026-03-20",
      "2026-03-20",
    );
    expect(created?.name).toBe("Leftovers");
    // Its only portion is sourced from the cook night's batch, which was not
    // part of this copy, so it is dropped rather than drawing on that batch.
    expect(copy.skippedPortions).toBe(1);
    const portionsAtCopy = await getDb(ctx.db)
      .select()
      .from(mealRecipePortion)
      .where(eq(mealRecipePortion.mealId, copy.mealIds[0]!));
    expect(portionsAtCopy).toHaveLength(0);
  });

  it("refuses an inverted or oversized range", async () => {
    await expect(
      copyMealRangeWorkflow(context(), {
        from: "2026-03-08",
        to: "2026-03-02",
        targetFrom: "2026-03-09",
      }),
    ).rejects.toThrow(/before it starts/);
    await expect(
      copyMealRangeWorkflow(context(), {
        from: "2026-01-01",
        to: "2026-12-31",
        targetFrom: "2027-01-01",
      }),
    ).rejects.toThrow(/limit/);
  });
});
