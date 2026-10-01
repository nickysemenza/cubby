import { splitExpenseInput } from "@cubby/schemas/purchase";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense } from "~/server/db/schema";

import { getDb, notDeleted } from "./database-helpers";
import { splitExpense } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

describe("atomic split classification intent", () => {
  const ctx = withTestDb();
  async function fixture() {
    const originalCategory = await insertWithShortcode(
      ctx.db,
      "spendingCategory",
      { name: "Original split classification" },
    );
    const reviewedCategory = await insertWithShortcode(
      ctx.db,
      "spendingCategory",
      { name: "Reviewed split classification" },
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic split vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const original = await insertWithShortcode(ctx.db, "expense", {
      name: "Unitemized fixture charge",
      cost: 60,
      date: "2026-09-01",
      purchaseId: purchase.id,
      spendingCategoryId: originalCategory.id,
      lineBasis: "allocation",
      lineKind: "principal",
      economicRole: "vendor",
      costType: "materials",
      trade: "other",
    });
    return { originalCategory, reviewedCategory, purchase, original };
  }
  it("atomically preserves omitted intent, resets null, and stores only explicitly reviewed categories", async () => {
    const { originalCategory, reviewedCategory, purchase, original } =
      await fixture();
    await splitExpense(
      ctx.db,
      splitExpenseInput.parse({
        expenseId: original.shortcode,
        parts: [
          {
            name: "Kept override",
            cost: 10,
            costType: "materials",
            trade: "other",
          },
          {
            name: "Inherited classification",
            cost: 20,
            costType: "materials",
            trade: "other",
            spendingCategoryId: null,
          },
          {
            name: "Reviewed override",
            cost: 30,
            costType: "services",
            trade: "other",
            spendingCategoryId: reviewedCategory.shortcode,
          },
        ],
      }),
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .select({
        name: expense.name,
        cost: expense.cost,
        category: expense.spendingCategoryId,
        basis: expense.lineBasis,
      })
      .from(expense)
      .where(and(eq(expense.purchaseId, purchase.id), notDeleted(expense)))
      .orderBy(expense.cost);
    expect(rows).toEqual([
      {
        name: "Kept override",
        cost: 10,
        category: originalCategory.id,
        basis: "allocation",
      },
      {
        name: "Inherited classification",
        cost: 20,
        category: null,
        basis: "allocation",
      },
      {
        name: "Reviewed override",
        cost: 30,
        category: reviewedCategory.id,
        basis: "allocation",
      },
    ]);
    expect(rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(60);
    expect(
      (
        await getDb(ctx.db).query.expense.findFirst({
          where: eq(expense.id, original.id),
        })
      )?.deletedAt,
    ).not.toBeNull();
  });
  it("refuses a Product on an unitemized allocation before retiring the source", async () => {
    const { original, purchase } = await fixture();
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic split product",
      manufacturer: "Synthetic fixture",
    });
    await expect(
      splitExpense(
        ctx.db,
        splitExpenseInput.parse({
          expenseId: original.shortcode,
          parts: [
            {
              name: "Unsupported allocation Product",
              cost: 30,
              costType: "materials",
              trade: "other",
              productId: product.shortcode,
            },
            {
              name: "Other allocation",
              cost: 30,
              costType: "services",
              trade: "other",
            },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    const live = await getDb(ctx.db)
      .select({ id: expense.id, cost: expense.cost })
      .from(expense)
      .where(and(eq(expense.purchaseId, purchase.id), notDeleted(expense)));
    expect(live).toEqual([{ id: original.id, cost: 60 }]);
  });
});
