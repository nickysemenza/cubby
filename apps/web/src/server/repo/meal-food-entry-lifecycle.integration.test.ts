import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromAny } from "@total-typescript/shoehorn";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  ingredient,
  ledgerParty,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
} from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
} from "~/server/repo/database-helpers";
import { amountToColumns } from "~/server/repo/database-helpers";
import { deleteIngredients } from "~/server/repo/ingredient/deletion";
import { mergeIngredients } from "~/server/repo/ingredient/merge";
import {
  deleteLedgerParties,
  mergeLedgerParties,
} from "~/server/repo/ledger-party";
import { deleteMeals } from "~/server/repo/meal/crud";
import { findOrphanedProducts } from "~/server/repo/problems/detectors-product";
import { deleteProducts } from "~/server/repo/product/crud";
import {
  mergeProducts,
  previewMergeProducts,
} from "~/server/repo/product/merge";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

describe("meal food entry lifecycle", () => {
  const ctx = withTestDb();

  const seedMeal = () =>
    insertWithShortcode(ctx.db, "meal", { date: "2026-09-14" });
  const seedParty = (name: string) =>
    insertWithShortcode(ctx.db, "ledgerParty", { name, kind: "member" });
  const seedProduct = (name: string) =>
    insertWithShortcode(ctx.db, "product", {
      name,
      manufacturer: "Lifecycle fixture",
    });
  const seedIngredient = (name: string) =>
    insertWithShortcode(ctx.db, "ingredient", { name });
  const seedPreparation = async (
    mealId: Awaited<ReturnType<typeof seedMeal>>["id"],
    name: string,
  ) => {
    const recipe = await insertWithShortcode(ctx.db, "recipe", { name });
    return insertAndReturn(ctx.db, mealRecipe, {
      mealId,
      recipeId: recipe.id,
    });
  };
  const omitAmount = <T extends { amount?: unknown }>({
    amount: _amount,
    ...rest
  }: T) => rest;
  const seedProductEntry = async (args: {
    mealId: Awaited<ReturnType<typeof seedMeal>>["id"];
    ledgerPartyId: Awaited<ReturnType<typeof seedParty>>["id"];
    productId: Awaited<ReturnType<typeof seedProduct>>["id"];
    amount?: { value: number; unit: string };
  }) =>
    insertAndReturn(ctx.db, mealFoodEntry, {
      ...omitAmount(args),
      ...amountToColumns(args.amount ?? { value: 1, unit: "g" }),
      sourceKind: "product",
    });
  const seedIngredientEntry = async (args: {
    mealId: Awaited<ReturnType<typeof seedMeal>>["id"];
    ledgerPartyId: Awaited<ReturnType<typeof seedParty>>["id"];
    ingredientId: Awaited<ReturnType<typeof seedIngredient>>["id"];
    amount?: { value: number; unit: string };
  }) =>
    insertAndReturn(ctx.db, mealFoodEntry, {
      ...omitAmount(args),
      ...amountToColumns(args.amount ?? { value: 1, unit: "g" }),
      sourceKind: "ingredient",
    });

  it("soft-deletes a meal's owned food entries", async () => {
    const [meal, party, product] = await Promise.all([
      seedMeal(),
      seedParty("Meal eater"),
      seedProduct("Meal product"),
    ]);
    const entry = await seedProductEntry({
      mealId: meal.id,
      ledgerPartyId: party.id,
      productId: product.id,
    });

    await deleteMeals(ctx.db, [meal.id], ctx.actor);

    const deleted = await getDb(ctx.db).query.mealFoodEntry.findFirst({
      where: and(
        eq(mealFoodEntry.id, entry.id),
        isNotNull(mealFoodEntry.deletedAt),
      ),
      columns: { id: true },
    });
    expect(deleted?.id).toBe(entry.id);
  });

  it("enforces canonical amount shape, migration exclusivity, and source exclusivity", async () => {
    const [meal, party, product, ingredientSource] = await Promise.all([
      seedMeal(),
      seedParty("Amount constraint eater"),
      seedProduct("Amount constraint product"),
      seedIngredient("Amount constraint ingredient"),
    ]);
    const base = {
      mealId: meal.id,
      ledgerPartyId: party.id,
      sourceKind: "product" as const,
      productId: product.id,
    };

    // The pair is atomic (both null or both set) and set means a positive,
    // finite value with a trimmed, non-empty unit.
    for (const badAmount of [
      { amountValue: 0, amountUnit: "g" },
      { amountValue: -1, amountUnit: "g" },
      { amountValue: Number.POSITIVE_INFINITY, amountUnit: "g" },
      { amountValue: 1, amountUnit: null },
      { amountValue: null, amountUnit: "g" },
      { amountValue: 1, amountUnit: " " },
      { amountValue: 1, amountUnit: " g" },
    ]) {
      await expect(
        getDb(ctx.db)
          .insert(mealFoodEntry)
          .values({ ...base, ...badAmount }),
      ).rejects.toMatchObject({
        cause: { constraint: "MealFoodEntry_amount_check" },
      });
    }
    await expect(
      getDb(ctx.db)
        .insert(mealFoodEntry)
        .values({
          ...base,
          ingredientId: ingredientSource.id,
          amountValue: 1,
          amountUnit: "g",
        }),
    ).rejects.toMatchObject({
      cause: { constraint: "MealFoodEntry_source_check" },
    });
    await expect(
      getDb(ctx.db)
        .insert(mealFoodEntry)
        .values({
          ...base,
          amountValue: null,
          amountUnit: null,
        }),
    ).rejects.toMatchObject({
      cause: { constraint: "MealFoodEntry_source_check" },
    });
    await expect(
      insertAndReturn(ctx.db, mealFoodEntry, {
        mealId: meal.id,
        ledgerPartyId: party.id,
        sourceKind: "manual",
        name: "Manual nutrition estimate",
        nutrients: { kcal: 50 },
        amountValue: null,
        amountUnit: null,
      }),
    ).resolves.toMatchObject({
      sourceKind: "manual",
      amountValue: null,
      amountUnit: null,
    });
  });

  it("blocks product deletion on live entries and ignores removed entries", async () => {
    const [meal, party, product] = await Promise.all([
      seedMeal(),
      seedParty("Product eater"),
      seedProduct("Referenced food"),
    ]);
    const entry = await seedProductEntry({
      mealId: meal.id,
      ledgerPartyId: party.id,
      productId: product.id,
    });

    const orphaned = await findOrphanedProducts(ctx.db);
    expect(orphaned.map((candidate) => candidate.id)).not.toContain(
      parseShortcodeFor("product", product.shortcode),
    );

    await expect(
      deleteProducts(ctx.db, [product.id], ctx.actor),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    await getDb(ctx.db)
      .update(mealFoodEntry)
      .set({ deletedAt: new Date() })
      .where(eq(mealFoodEntry.id, entry.id));
    await expect(
      deleteProducts(ctx.db, [product.id], ctx.actor),
    ).resolves.toMatchObject({ deleted: 1 });
  });

  it("blocks ingredient deletion on live entries and ignores removed entries", async () => {
    const [meal, party, source] = await Promise.all([
      seedMeal(),
      seedParty("Ingredient eater"),
      seedIngredient("Recorded ingredient"),
    ]);
    const entry = await seedIngredientEntry({
      mealId: meal.id,
      ledgerPartyId: party.id,
      ingredientId: source.id,
    });

    await expect(
      deleteIngredients(ctx.db, [source.id], ctx.actor),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });

    await getDb(ctx.db)
      .update(mealFoodEntry)
      .set({ deletedAt: new Date() })
      .where(eq(mealFoodEntry.id, entry.id));
    await expect(
      deleteIngredients(ctx.db, [source.id], ctx.actor),
    ).resolves.toMatchObject({ deleted: 1 });
  });

  it("re-points live and removed ingredient entries during a hard-delete merge", async () => {
    const [meal, party, keep, lose] = await Promise.all([
      seedMeal(),
      seedParty("Ingredient merge eater"),
      seedIngredient("Ingredient keeper"),
      seedIngredient("Ingredient loser"),
    ]);
    const [liveEntry, removedEntry] = await Promise.all([
      seedIngredientEntry({
        mealId: meal.id,
        ledgerPartyId: party.id,
        ingredientId: lose.id,
        amount: { value: 2.5, unit: "tbsp" },
      }),
      seedIngredientEntry({
        mealId: meal.id,
        ledgerPartyId: party.id,
        ingredientId: lose.id,
        amount: { value: 3, unit: "pinch" },
      }),
    ]);
    await getDb(ctx.db)
      .update(mealFoodEntry)
      .set({ deletedAt: new Date() })
      .where(eq(mealFoodEntry.id, removedEntry.id));

    await mergeIngredients(
      ctx.db,
      { keepId: keep.shortcode, mergeIds: [lose.shortcode] },
      ctx.actor,
    );

    const moved = await getDb(ctx.db)
      .select({
        id: mealFoodEntry.id,
        ingredientId: mealFoodEntry.ingredientId,
        amountValue: mealFoodEntry.amountValue,
        amountUnit: mealFoodEntry.amountUnit,
        deletedAt: mealFoodEntry.deletedAt,
      })
      .from(mealFoodEntry)
      .where(inArray(mealFoodEntry.id, [liveEntry.id, removedEntry.id]));
    expect(moved).toEqual(
      expect.arrayContaining([
        {
          id: liveEntry.id,
          ingredientId: keep.id,
          amountValue: 2.5,
          amountUnit: "tbsp",
          deletedAt: null,
        },
        {
          id: removedEntry.id,
          ingredientId: keep.id,
          amountValue: 3,
          amountUnit: "pinch",
          deletedAt: expect.any(Date),
        },
      ]),
    );
    await expect(
      getDb(ctx.db).query.ingredient.findFirst({
        where: eq(ingredient.id, lose.id),
      }),
    ).resolves.toBeUndefined();
  });

  it("re-points product entries during merge without changing the amount", async () => {
    const [meal, party, keep, lose] = await Promise.all([
      seedMeal(),
      seedParty("Product merge eater"),
      seedProduct("Product keeper"),
      seedProduct("Product loser"),
    ]);
    const entry = await seedProductEntry({
      mealId: meal.id,
      ledgerPartyId: party.id,
      productId: lose.id,
      amount: { value: 42.5, unit: "g" },
    });

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keep.id,
      mergeIds: [lose.id],
    });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "repoint-meal-food-entries",
          total: 1,
        }),
      ]),
    );
    await mergeProducts(
      ctx.db,
      {
        keepId: parseShortcodeFor("product", keep.shortcode),
        mergeIds: [parseShortcodeFor("product", lose.shortcode)],
      },
      ctx.actor,
    );

    const moved = await getDb(ctx.db).query.mealFoodEntry.findFirst({
      where: and(eq(mealFoodEntry.id, entry.id), notDeleted(mealFoodEntry)),
      columns: { productId: true, amountValue: true, amountUnit: true },
    });
    expect(moved).toEqual({
      productId: keep.id,
      amountValue: 42.5,
      amountUnit: "g",
    });
  });

  it("blocks party deletion and re-points entries during party merge", async () => {
    const [meal, keep, lose, product] = await Promise.all([
      seedMeal(),
      seedParty("Party keeper"),
      seedParty("Party loser"),
      seedProduct("Party merge food"),
    ]);
    const entry = await seedProductEntry({
      mealId: meal.id,
      ledgerPartyId: lose.id,
      productId: product.id,
      amount: { value: 17.25, unit: "g" },
    });
    const loseCode = parseShortcodeFor("ledgerParty", lose.shortcode);

    await expect(
      deleteLedgerParties(ctx.db, [loseCode], ctx.actor),
    ).rejects.toThrow("meal food entries");
    const result = await mergeLedgerParties(
      ctx.db,
      {
        keepId: parseShortcodeFor("ledgerParty", keep.shortcode),
        mergeIds: [loseCode],
      },
      ctx.actor,
    );
    expect(result.mergeSummary.foodEntryEdgesRepointed).toBe(1);

    const moved = await getDb(ctx.db).query.mealFoodEntry.findFirst({
      where: and(
        eq(mealFoodEntry.id, entry.id),
        isNull(mealFoodEntry.deletedAt),
      ),
      columns: { ledgerPartyId: true, amountValue: true, amountUnit: true },
    });
    expect(moved).toEqual({
      ledgerPartyId: keep.id,
      amountValue: 17.25,
      amountUnit: "g",
    });
  });

  it("folds matching canonical portion units into a summed canonical amount", async () => {
    const [meal, keep, lose] = await Promise.all([
      seedMeal(),
      seedParty("Portion keeper"),
      seedParty("Portion loser"),
    ]);
    const volumePreparation = await seedPreparation(
      meal.id,
      "Volume portion recipe",
    );
    await getDb(ctx.db)
      .insert(mealRecipePortion)
      .values([
        {
          mealRecipeId: volumePreparation.id,
          mealId: meal.id,
          ledgerPartyId: keep.id,
          amountValue: 0.75,
          amountUnit: "cup",
        },
        {
          mealRecipeId: volumePreparation.id,
          mealId: meal.id,
          ledgerPartyId: lose.id,
          amountValue: 1.25,
          amountUnit: "cup",
        },
      ]);

    const result = await mergeLedgerParties(
      ctx.db,
      {
        keepId: parseShortcodeFor("ledgerParty", keep.shortcode),
        mergeIds: [parseShortcodeFor("ledgerParty", lose.shortcode)],
      },
      ctx.actor,
    );

    expect(result.mergeSummary.portionEdgesRepointed).toBe(1);
    const folded = await getDb(ctx.db)
      .select({
        mealRecipeId: mealRecipePortion.mealRecipeId,
        amountValue: mealRecipePortion.amountValue,
        amountUnit: mealRecipePortion.amountUnit,
      })
      .from(mealRecipePortion)
      .where(
        and(
          eq(mealRecipePortion.ledgerPartyId, keep.id),
          isNull(mealRecipePortion.deletedAt),
        ),
      );
    expect(folded).toEqual([
      {
        mealRecipeId: volumePreparation.id,
        amountValue: 2,
        amountUnit: "cup",
      },
    ]);
  });

  it("requires an amount for every recipe portion", async () => {
    const [meal, party] = await Promise.all([
      seedMeal(),
      seedParty("Portion constraint eater"),
    ]);
    const preparation = await seedPreparation(
      meal.id,
      "Portion constraint recipe",
    );
    const base = {
      mealRecipeId: preparation.id,
      mealId: meal.id,
      ledgerPartyId: party.id,
    };

    await expect(
      getDb(ctx.db)
        .insert(mealRecipePortion)
        .values({
          ...base,
          // SAFETY: deliberately bypassing the NOT NULL type to prove the
          // database itself refuses a portion with no amount.
          amountValue: fromAny(sql`null`),
          amountUnit: "cup",
        }),
    ).rejects.toMatchObject({
      cause: { code: "23502", column: "amountValue" },
    });
    // A set amount is positive, finite, with a trimmed non-empty unit.
    for (const bad of [
      { amountValue: 0, amountUnit: "cup" },
      { amountValue: -2, amountUnit: "cup" },
      { amountValue: Number.POSITIVE_INFINITY, amountUnit: "cup" },
      { amountValue: 1, amountUnit: " " },
    ]) {
      await expect(
        getDb(ctx.db)
          .insert(mealRecipePortion)
          .values({ ...base, ...bad }),
      ).rejects.toMatchObject({
        cause: { constraint: "MealRecipePortion_amount_check" },
      });
    }
  });

  it("refuses to fold colliding recipe portions with different entered units", async () => {
    const [meal, keep, lose] = await Promise.all([
      seedMeal(),
      seedParty("Mixed-unit keeper"),
      seedParty("Mixed-unit loser"),
    ]);
    const preparation = await seedPreparation(
      meal.id,
      "Mixed-unit portion recipe",
    );
    await getDb(ctx.db)
      .insert(mealRecipePortion)
      .values([
        {
          mealRecipeId: preparation.id,
          mealId: meal.id,
          ledgerPartyId: keep.id,
          amountValue: 1,
          amountUnit: "cup",
        },
        {
          mealRecipeId: preparation.id,
          mealId: meal.id,
          ledgerPartyId: lose.id,
          amountValue: 8,
          amountUnit: "oz",
        },
      ]);

    await expect(
      mergeLedgerParties(
        ctx.db,
        {
          keepId: parseShortcodeFor("ledgerParty", keep.shortcode),
          mergeIds: [parseShortcodeFor("ledgerParty", lose.shortcode)],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "CONSTRAINT_VIOLATION",
      message: expect.stringMatching(/reconcile the portion units/u),
    });

    const [loserAfter, portionsAfter] = await Promise.all([
      getDb(ctx.db).query.ledgerParty.findFirst({
        where: and(eq(ledgerParty.id, lose.id), isNull(ledgerParty.deletedAt)),
        columns: { id: true },
      }),
      getDb(ctx.db).query.mealRecipePortion.findMany({
        where: and(
          eq(mealRecipePortion.mealRecipeId, preparation.id),
          isNull(mealRecipePortion.deletedAt),
        ),
        columns: { amountValue: true, amountUnit: true },
      }),
    ]);
    expect(loserAfter?.id).toBe(lose.id);
    expect(portionsAfter).toEqual(
      expect.arrayContaining([
        { amountValue: 1, amountUnit: "cup" },
        { amountValue: 8, amountUnit: "oz" },
      ]),
    );
  });
});
