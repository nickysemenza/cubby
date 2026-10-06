import {
  parseShortcodeFor,
  type SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  expense,
  financialTransaction,
  productCategory,
  purchase,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

import { unwrapDb } from "./database-helpers";
import { insertWithShortcode } from "./shortcode-utils";
import {
  applySpendingClassificationReview,
  previewSpendingClassificationReview,
} from "./spending-classification-review";
import { withReviewedSpendingClassification } from "./spending-classification-review-authorization";

// Merging spending categories reclassifies history. Failure modes: an incoming
// reference (Purchase, Expense override, transaction, merchant default,
// Product Category mapping, child category) keeps pointing at a merged-away
// category; a merge makes the keeper its own ancestor; an unreviewed merge
// silently moves historical Expense totals; a merge into a `not_allowed`
// keeper strands a Product on a restaurant-style line; or the loser vanishes
// without an audit trail.
describe("spending category merge", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse({
      ...createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
      actorContext: ctx.actor,
    });
  const category = (
    name: string,
    extra: {
      parentId?: SpendingCategoryId;
      productExpectation?: "not_allowed" | "not_expected";
    } = {},
  ) =>
    insertWithShortcode(ctx.db, "spendingCategory", {
      name: `${name} ${crypto.randomUUID()}`,
      ...extra,
    });
  const merge = (keepId: string, mergeIds: string[]) =>
    executeEntity(context(), {
      action: "merge",
      entity: "spendingCategory",
      data: { keepId, mergeIds },
    });

  async function referencesTo(loserId: SpendingCategoryId) {
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic merge owner",
      kind: "member",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic merge account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.id,
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 18,
        postedDate: "2026-09-02",
        merchant: "Synthetic pet shop",
        spendingCategoryId: loserId,
      },
    );
    const shop = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic pet shop ${crypto.randomUUID()}`,
      spendingProfile: "mixed_retail",
      defaultSpendingCategoryId: loserId,
    });
    const mapping = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Synthetic pet supplies ${crypto.randomUUID()}`,
      spendingCategoryMode: "mapped",
      spendingCategoryId: loserId,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: shop.id,
      date: "2026-09-02",
      spendingCategoryId: loserId,
      spendingCategoryOrigin: "manual",
      defaultTrade: "other",
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      name: "Synthetic kibble",
      cost: 18,
      date: "2026-09-02",
      costType: "materials",
      trade: "other",
      spendingCategoryId: loserId,
    });
    return { transaction, shop, mapping, order, line };
  }

  it("repoints every reference, reparents children, and records the audit trail", async () => {
    const pets = await category("Synthetic pets");
    const pet = await category("Synthetic pet");
    const grooming = await category("Synthetic grooming", {
      parentId: pet.id,
    });
    const refs = await referencesTo(pet.id);
    const request = {
      action: "spendingCategoryMerge" as const,
      keepId: parseShortcodeFor("spendingCategory", pets.shortcode),
      mergeIds: [parseShortcodeFor("spendingCategory", pet.shortcode)],
    };

    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBeGreaterThanOrEqual(1);
    expect(
      preview.categoryDeltas.find(
        (row) => row.spendingCategoryId === pets.shortcode,
      )?.deltaCents,
    ).toBe("1800");
    await applySpendingClassificationReview(context(), {
      request,
      fingerprint: preview.fingerprint,
    });

    const db = unwrapDb(ctx.db);
    const one = async <T>(rows: Promise<T[]>) => (await rows)[0];
    expect(
      await one(
        db
          .select({ id: spendingCategory.parentId })
          .from(spendingCategory)
          .where(eq(spendingCategory.id, grooming.id)),
      ),
    ).toEqual({ id: pets.id });
    for (const [table, id, column] of [
      [expense, refs.line.id, expense.spendingCategoryId],
      [purchase, refs.order.id, purchase.spendingCategoryId],
      [
        financialTransaction,
        refs.transaction.id,
        financialTransaction.spendingCategoryId,
      ],
      [vendor, refs.shop.id, vendor.defaultSpendingCategoryId],
      [productCategory, refs.mapping.id, productCategory.spendingCategoryId],
    ] as const) {
      expect(
        await one(
          db.select({ id: column }).from(table).where(eq(table.id, id)),
        ),
      ).toEqual({ id: pets.id });
    }
    const [loser] = await db
      .select({ deletedAt: spendingCategory.deletedAt })
      .from(spendingCategory)
      .where(eq(spendingCategory.id, pet.id));
    expect(loser?.deletedAt).not.toBeNull();

    const audits = await db
      .select({
        entityId: auditLog.entityId,
        action: auditLog.action,
        changes: auditLog.changes,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "spendingCategory"),
          inArray(auditLog.entityId, [pets.id, pet.id]),
        ),
      );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: pets.id,
          action: "update",
          changes: { mergedFrom: { from: null, to: [pet.id] } },
        }),
        expect.objectContaining({ entityId: pet.id, action: "delete" }),
      ]),
    );
  });

  it("refuses an unreviewed merge that reclassifies Expense history", async () => {
    const pets = await category("Synthetic pets");
    const pet = await category("Synthetic pet");
    await referencesTo(pet.id);
    await expect(merge(pets.shortcode, [pet.shortcode])).rejects.toThrow(
      /reviewed spending classification/i,
    );
  });

  it("merges directly when no Expense changes classification", async () => {
    const pets = await category("Synthetic pets");
    const pet = await category("Synthetic pet");
    const child = await category("Synthetic pet toys", { parentId: pet.id });
    const result = await merge(pets.shortcode, [pet.shortcode]);
    expect(result.action === "merge" && result.item.id).toBe(pets.shortcode);
    const [row] = await unwrapDb(ctx.db)
      .select({ parentId: spendingCategory.parentId })
      .from(spendingCategory)
      .where(eq(spendingCategory.id, child.id));
    expect(row?.parentId).toBe(pets.id);
  });

  it("refuses a merge that would make the keeper its own ancestor", async () => {
    const food = await category("Synthetic food and drink");
    const restaurants = await category("Synthetic restaurants", {
      parentId: food.id,
    });
    const diners = await category("Synthetic diners", {
      parentId: restaurants.id,
    });
    await expect(merge(diners.shortcode, [food.shortcode])).rejects.toThrow(
      /own ancestor/i,
    );
    await expect(
      merge(restaurants.shortcode, [food.shortcode]),
    ).rejects.toThrow(/own ancestor/i);
  });

  it("refuses merging Product-linked lines into a keeper that forbids Products", async () => {
    const restaurants = await category("Synthetic restaurants", {
      productExpectation: "not_allowed",
    });
    const groceries = await category("Synthetic groceries", {
      productExpectation: "not_expected",
    });
    const shop = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic grocer ${crypto.randomUUID()}`,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: shop.id,
      date: "2026-09-03",
      spendingCategoryId: groceries.id,
      spendingCategoryOrigin: "manual",
      defaultTrade: "other",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: `Synthetic chili crisp ${crypto.randomUUID()}`,
      manufacturer: "",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      name: "Synthetic chili crisp",
      cost: 9,
      date: "2026-09-03",
      costType: "materials",
      trade: "other",
      productId: item.id,
      productQuantity: 1,
    });
    await expect(
      withReviewedSpendingClassification(ctx.db, () =>
        merge(restaurants.shortcode, [groceries.shortcode]),
      ),
    ).rejects.toThrow(/does not allow/i);
    const [loser] = await unwrapDb(ctx.db)
      .select({ deletedAt: spendingCategory.deletedAt })
      .from(spendingCategory)
      .where(eq(spendingCategory.id, groceries.id));
    expect(loser?.deletedAt).toBeNull();
  });
});
