import {
  parseShortcodeFor,
  type SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import { TEST_ACTOR } from "tooling/test-setup";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";
import {
  auditLog,
  expense,
  financialTransaction,
  productCategory,
  purchase,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import { receivableProductIds } from "~/server/domains/inventory/repo/stock-tracking";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findReferentialLivenessViolations } from "~/server/generic/problems/repo/detectors-integrity";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

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
      lineKind: "principal",
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

  // Regression: targets resolved before the transaction, so a keeper deleted
  // after preview received the children and the loser's redirect.
  it("refuses a reviewed merge whose keeper was deleted after preview", async () => {
    const pets = await category("Synthetic pets");
    const pet = await category("Synthetic pet");
    const child = await category("Synthetic pet toys", { parentId: pet.id });
    await referencesTo(pet.id);
    const request = {
      action: "spendingCategoryMerge" as const,
      keepId: parseShortcodeFor("spendingCategory", pets.shortcode),
      mergeIds: [parseShortcodeFor("spendingCategory", pet.shortcode)],
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    await unwrapDb(ctx.db)
      .update(spendingCategory)
      .set({ deletedAt: new Date() })
      .where(eq(spendingCategory.id, pets.id));
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/was deleted/i);
    const rows = await unwrapDb(ctx.db)
      .select({
        id: spendingCategory.id,
        parentId: spendingCategory.parentId,
        deletedAt: spendingCategory.deletedAt,
      })
      .from(spendingCategory)
      .where(inArray(spendingCategory.id, [pet.id, child.id]));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: pet.id, parentId: null, deletedAt: null },
        { id: child.id, parentId: pet.id, deletedAt: null },
      ]),
    );
  });

  // The accepted residual race: a writer that resolved a loser before the
  // merge commits its reference afterward. The dangling-reference problem
  // reports every such edge so a person can fix it by hand.
  it("reports a reference committed to a merged-away category", async () => {
    const pets = await category("Synthetic pets");
    const pet = await category("Synthetic pet");
    const child = await category("Synthetic pet toys");
    await merge(pets.shortcode, [pet.shortcode]);
    const late = await referencesTo(pet.id);
    await unwrapDb(ctx.db)
      .update(spendingCategory)
      .set({ parentId: pet.id })
      .where(eq(spendingCategory.id, child.id));
    const reported = (await findReferentialLivenessViolations(ctx.db))
      .filter((row) => row.targetId === pet.id)
      .map((row) => [row.edgeKey, row.sourceId]);
    expect(reported).toEqual(
      expect.arrayContaining([
        ["Expense.spendingCategoryId", late.line.id],
        ["Purchase.spendingCategoryId", late.order.id],
        ["FinancialTransaction.spendingCategoryId", late.transaction.id],
        ["Vendor.defaultSpendingCategoryId", late.shop.id],
        ["ProductCategory.spendingCategoryId", late.mapping.id],
        ["SpendingCategory.parentId", child.id],
      ]),
    );
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
      lineKind: "principal",
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

// Failure: stock-tracking decisions change without an audit trail because the
// repository's audit roster drifts from the declaration's.
describe("spending category stock tracking", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse({
      ...createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
      actorContext: ctx.actor,
    });

  it("audits an update that changes only stockTracked", async () => {
    const tools = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Synthetic tools ${crypto.randomUUID()}`,
    });
    await executeEntity(context(), {
      action: "update",
      entity: "spendingCategory",
      id: tools.shortcode,
      data: { stockTracked: false },
    });
    const audits = await unwrapDb(ctx.db)
      .select({ action: auditLog.action, changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "spendingCategory"),
          eq(auditLog.entityId, tools.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audits).toEqual([
      {
        action: "update",
        changes: { stockTracked: { from: null, to: false } },
      },
    ]);
  });

  // Failure: a child that stores no decision under a parent storing false
  // reads null while the arrival gate treats it as false, provenance names no
  // parent, and "Use inherited" has no reset to apply.
  it("reads, explains, resets, and gates arrivals on the inherited decision", async () => {
    const parent = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Synthetic groceries ${crypto.randomUUID()}`,
      stockTracked: false,
    });
    const child = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Synthetic produce ${crypto.randomUUID()}`,
      parentId: parent.id,
    });
    const resolution = z.object({
      mode: z.string(),
      value: z.boolean().nullable(),
      storedValue: z.boolean().nullable(),
      canReset: z.boolean(),
      sourceEntity: z.object({ entityId: z.string() }).nullable(),
    });
    const read = z.object({
      item: z.object({
        stockTracked: z.boolean().nullable(),
        fieldResolutions: z.object({ stockTracked: resolution }),
      }),
    });
    const get = async () =>
      read.parse(
        await executeEntity(context(), {
          action: "get",
          entity: "spendingCategory",
          id: child.shortcode,
          missing: "error",
        }),
      ).item;

    const inherited = await get();
    expect(inherited.stockTracked).toBe(false);
    expect(inherited.fieldResolutions.stockTracked).toEqual({
      mode: "inherit",
      value: false,
      storedValue: null,
      canReset: false,
      sourceEntity: expect.objectContaining({ entityId: parent.shortcode }),
    });
    const listed = z
      .object({
        items: z.array(
          z.object({ id: z.string(), stockTracked: z.boolean().nullable() }),
        ),
      })
      .parse(
        await executeEntity(context(), {
          action: "list",
          entity: "spendingCategory",
          filters: {},
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      );
    expect(
      listed.items.find((item) => item.id === child.shortcode)?.stockTracked,
    ).toBe(false);

    const shop = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic market ${crypto.randomUUID()}`,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: shop.id,
      date: "2026-09-03",
    });
    const apples = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic apples", stockTracked: null }),
      TEST_ACTOR,
    );
    await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      purchaseId: order.id,
      productId: apples.entityId,
      name: "Synthetic apples",
      cost: 4,
      date: "2026-09-03",
      costType: "materials",
      trade: "other",
      spendingCategoryId: child.id,
    });
    expect(
      await receivableProductIds(ctx.db, [apples.entityId], order.id),
    ).toEqual(new Set());

    await executeEntity(context(), {
      action: "update",
      entity: "spendingCategory",
      id: child.shortcode,
      data: { stockTracked: true },
    });
    expect((await get()).fieldResolutions.stockTracked).toMatchObject({
      mode: "explicit",
      value: true,
      canReset: true,
    });
    expect(
      await receivableProductIds(ctx.db, [apples.entityId], order.id),
    ).toEqual(new Set([apples.entityId]));

    await executeEntity(context(), {
      action: "update",
      entity: "spendingCategory",
      id: child.shortcode,
      data: { stockTracked: null },
    });
    expect((await get()).stockTracked).toBe(false);
  });
});
