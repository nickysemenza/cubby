import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mealFoodEntry } from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
} from "~/server/repo/database-helpers";
import {
  deleteLedgerParties,
  mergeLedgerParties,
  previewMergeLedgerParties,
} from "~/server/repo/ledger-party";
import { deleteMeals } from "~/server/repo/meal";
import { findOrphanedProducts } from "~/server/repo/problems";
import {
  deleteProducts,
  mergeProducts,
  previewMergeProducts,
} from "~/server/repo/product";
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
  const seedProductEntry = async (args: {
    mealId: Awaited<ReturnType<typeof seedMeal>>["id"];
    ledgerPartyId: Awaited<ReturnType<typeof seedParty>>["id"];
    productId: Awaited<ReturnType<typeof seedProduct>>["id"];
    grams?: number;
  }) =>
    insertAndReturn(ctx.db, mealFoodEntry, {
      ...args,
      grams: args.grams ?? 1,
      sourceKind: "product",
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
    ).rejects.toMatchObject({ cause: { reason: "CONSTRAINT_VIOLATION" } });

    await getDb(ctx.db)
      .update(mealFoodEntry)
      .set({ deletedAt: new Date() })
      .where(eq(mealFoodEntry.id, entry.id));
    await expect(
      deleteProducts(ctx.db, [product.id], ctx.actor),
    ).resolves.toMatchObject({ deleted: 1 });
  });

  it("re-points product entries during merge without changing grams", async () => {
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
      grams: 42.5,
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
      columns: { productId: true, grams: true },
    });
    expect(moved).toEqual({ productId: keep.id, grams: 42.5 });
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
      grams: 17.25,
    });
    const loseCode = parseShortcodeFor("ledgerParty", lose.shortcode);

    await expect(
      deleteLedgerParties(ctx.db, [loseCode], ctx.actor),
    ).rejects.toThrow("meal food entries");
    const preview = await previewMergeLedgerParties(ctx.db, {
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
      columns: { ledgerPartyId: true, grams: true },
    });
    expect(moved).toEqual({ ledgerPartyId: keep.id, grams: 17.25 });
  });
});
