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

  // Reassignment can change historical allocations without changing an Expense;
  // even an unbooked Product must participate in the stale-review fingerprint.
  it("reviews Product taxonomy reassignment without overwriting Expense intent", async () => {
    const oldSpend = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture furnishings",
    });
    const toolsSpend = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture tools",
    });
    const oldCategory = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture storage",
      spendingCategoryMode: "mapped",
      spendingCategoryId: oldSpend.id,
    });
    const parent = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools",
      spendingCategoryMode: "mapped",
      spendingCategoryId: toolsSpend.id,
    });
    const target = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tool storage",
      parentId: parent.id,
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture tool box",
      manufacturer: "Fixture",
      categoryId: oldCategory.id,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture item",
      cost: -20,
      productQuantity: -1,
      productId: item.id,
      date: "2026-09-01",
      costType: "tools",
      trade: "other",
    });
    const override = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture explicit purpose",
      cost: 10,
      productQuantity: 1,
      productId: item.id,
      spendingCategoryId: oldSpend.id,
      date: "2026-09-02",
      costType: "tools",
      trade: "other",
    });
    const request = {
      action: "products" as const,
      productIds: [parseShortcodeFor("product", item.shortcode)],
      productCategoryId: parseShortcodeFor("productCategory", target.shortcode),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "categoryId" FROM "Product" WHERE id=${item.id}`,
        )
      ).rows[0]?.categoryId,
    ).toBe(oldCategory.id);
    await applySpendingClassificationReview(context(), {
      request,
      fingerprint: preview.fingerprint,
    });
    const resolved = await unwrapDb(ctx.db).execute(
      sql`SELECT id,cost,"productQuantity",${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e WHERE e.id IN (${line.id},${override.id})`,
    );
    expect(resolved.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: line.id,
          cost: -20,
          productQuantity: -1,
          category: toolsSpend.id,
        }),
        expect.objectContaining({
          id: override.id,
          cost: 10,
          productQuantity: 1,
          category: oldSpend.id,
        }),
      ]),
    );
  });

  it("refuses a stale reassignment of a Product with no Expenses", async () => {
    const source = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture old taxonomy",
    });
    const target = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture target taxonomy",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture unbooked item",
      manufacturer: "Fixture",
      categoryId: source.id,
    });
    const request = {
      action: "products" as const,
      productIds: [parseShortcodeFor("product", item.shortcode)],
      productCategoryId: parseShortcodeFor("productCategory", target.shortcode),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Product" SET "categoryId"=NULL WHERE id=${item.id}`,
    );
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "categoryId" FROM "Product" WHERE id=${item.id}`,
        )
      ).rows[0]?.categoryId,
    ).toBeNull();
  });

  it("refuses taxonomy changes that would change Food allocation semantics", async () => {
    const food = await unwrapDb(ctx.db).query.productCategory.findFirst({
      where: (category, { eq }) => eq(category.feature, "food"),
    });
    if (!food) throw new Error("Missing synthetic Food feature root");
    const tools = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools root",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture food item",
      manufacturer: "Fixture",
      categoryId: food.id,
    });
    await expect(
      previewSpendingClassificationReview(ctx.db, {
        action: "products",
        productIds: [parseShortcodeFor("product", item.shortcode)],
        productCategoryId: parseShortcodeFor(
          "productCategory",
          tools.shortcode,
        ),
      }),
    ).rejects.toThrow("feature");
  });

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

  // The fingerprint covers only Expenses the draft can affect: one that joins
  // the scope after preview stales it, an unaffected edit does not.
  it("stales a Vendor review only when an affected Expense changes", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture dining",
    });
    const reviewed = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture cafe",
    });
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture hardware store",
    });
    const line = async (vendorId: typeof reviewed.id) => {
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        date: "2026-09-01",
        vendorId,
      });
      return insertWithShortcode(ctx.db, "expense", {
        name: "Fixture line",
        date: "2026-09-01",
        cost: 8.5,
        costType: "materials",
        trade: "other",
        purchaseId: purchase.id,
      });
    };
    await line(reviewed.id);
    const unrelated = await line(other.id);
    const joining = await line(other.id);
    const request = {
      action: "vendor" as const,
      vendorId: parseShortcodeFor("vendor", reviewed.shortcode),
      spendingProfile: "restaurant" as const,
      defaultSpendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        category.shortcode,
      ),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET cost=9 WHERE id=${unrelated.id}`,
    );
    const stillCurrent = await previewSpendingClassificationReview(
      ctx.db,
      request,
    );
    expect(stillCurrent.fingerprint).toBe(preview.fingerprint);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "vendorId"=${reviewed.id} WHERE id=${joining.purchaseId}`,
    );
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
  });

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
