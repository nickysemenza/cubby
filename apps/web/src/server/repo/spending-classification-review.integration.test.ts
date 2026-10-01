import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

import { unwrapDb } from "./database-helpers";
import { effectiveExpenseSpendingCategorySql } from "./expense-category-resolution";
import { insertWithShortcode } from "./shortcode-utils";
import {
  applySpendingClassificationReview,
  applyReviewedSpendingClassificationPolicy,
  previewSpendingClassificationReview,
} from "./spending-classification-review";

// Database boundary regressions: preview must not write, and a changed amount
// or policy between preview/apply must refuse before any category assignment.
describe("reviewed spending classification", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it.each(["productCategory", "vendor"] as const)(
    "authorizes only the reviewed %s write through kernel savepoints",
    async (action) => {
      const category = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Fixture reviewed category",
      });
      const productCategory = await insertWithShortcode(
        ctx.db,
        "productCategory",
        { name: "Fixture reviewed taxonomy" },
      );
      const product = await insertWithShortcode(ctx.db, "product", {
        name: "Fixture item",
        manufacturer: "Fixture",
        categoryId: productCategory.id,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Fixture reviewed merchant",
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        date: "2026-09-01",
        vendorId: vendor.id,
      });
      const expense = await insertWithShortcode(ctx.db, "expense", {
        name: "Fixture historical expense",
        date: "2026-09-01",
        cost: 12.34,
        costType: "materials",
        trade: "other",
        purchaseId: purchase.id,
        productId: action === "productCategory" ? product.id : null,
      });
      const target = parseShortcodeFor("spendingCategory", category.shortcode);
      const productCategoryCode = parseShortcodeFor(
        "productCategory",
        productCategory.shortcode,
      );
      const vendorCode = parseShortcodeFor("vendor", vendor.shortcode);
      const request =
        action === "productCategory"
          ? {
              action,
              productCategoryId: productCategoryCode,
              spendingCategoryMode: "mapped" as const,
              spendingCategoryId: target,
            }
          : {
              action,
              vendorId: vendorCode,
              spendingProfile: "restaurant" as const,
              defaultSpendingCategoryId: target,
            };
      const unreviewed = () =>
        action === "productCategory"
          ? executeEntity(context(), {
              action: "update",
              entity: "productCategory",
              id: productCategoryCode,
              data: {
                spendingCategoryMode: "blocked",
                spendingCategoryId: null,
              },
            })
          : executeEntity(context(), {
              action: "update",
              entity: "vendor",
              id: vendorCode,
              data: {
                spendingProfile: "mixed_retail",
                defaultSpendingCategoryId: null,
              },
            });
      await expect(unreviewed()).rejects.toThrow(/Preview and apply/);
      await expect(
        applyReviewedSpendingClassificationPolicy(context(), request),
      ).rejects.toThrow(/Preview and apply/);
      const preview = await previewSpendingClassificationReview(
        ctx.db,
        request,
      );
      expect(preview.changedExpenseCount).toBe(1);
      await expect(
        applySpendingClassificationReview(context(), {
          request,
          fingerprint: preview.fingerprint,
        }),
      ).resolves.toMatchObject({ applied: true, updatedRecords: 1 });
      const resolved = await unwrapDb(ctx.db).execute(
        sql`SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e WHERE e.id=${expense.id}`,
      );
      expect(resolved.rows[0]?.category).toBe(category.id);
      // A completed review cannot authorize a later unrelated request.
      await expect(unreviewed()).rejects.toThrow(/Preview and apply/);
      await expect(
        applyReviewedSpendingClassificationPolicy(context(), request),
      ).rejects.toThrow(/Preview and apply/);
    },
  );

  it("previews exact money without writes and rejects changed history before apply", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture gifts",
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture purchase",
      cost: 12.34,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
    });
    const request = {
      action: "expenses" as const,
      expenseIds: [parseShortcodeFor("expense", expense.shortcode)],
      spendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        category.shortcode,
      ),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    expect(preview.categoryDeltas).toContainEqual(
      expect.objectContaining({
        spendingCategoryId: request.spendingCategoryId,
        beforeCents: "0",
        afterCents: "1234",
        deltaCents: "1234",
      }),
    );
    const before = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryId" FROM "Expense" WHERE id=${expense.id}`,
    );
    expect(before.rows[0]?.spendingCategoryId).toBeNull();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET cost=15 WHERE id=${expense.id}`,
    );
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
    const after = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryId" FROM "Expense" WHERE id=${expense.id}`,
    );
    expect(after.rows[0]?.spendingCategoryId).toBeNull();
  });
});
