import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "./database-helpers";
import { expenseSpendingAllocationSql } from "./expense-spending-allocation";
import { effectiveExpenseSpendingCategorySql } from "./purchase-evidence-policy";
import { insertWithShortcode } from "./shortcode-utils";

// Real SQL regressions: mixed retailer purchases must not flatten Product
// classifications, blocked ancestors must remain unknown, and restaurant
// context must classify Food without classifying unrelated merchandise.
describe("Expense category resolution", () => {
  const ctx = withTestDb();
  async function fixture() {
    const clothing = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture clothing",
    });
    const electronics = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture electronics",
    });
    const gifts = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture gifts",
    });
    const root = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture apparel",
    });
    const child = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture shoes",
      parentId: root.id,
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture shoes",
      manufacturer: "Fixture",
      categoryId: child.id,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture mixed shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      date: "2026-09-01",
      vendorId: vendor.id,
      spendingCategoryId: electronics.id,
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture shoes",
      date: "2026-09-01",
      cost: 60,
      costType: "materials",
      productId: product.id,
      purchaseId: purchase.id,
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "ProductCategory" SET "spendingCategoryMode"='mapped',"spendingCategoryId"=${clothing.id} WHERE id=${root.id}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Vendor" SET "spendingProfile"='mixed_retail' WHERE id=${vendor.id}`,
    );
    return {
      clothing,
      electronics,
      gifts,
      root,
      child,
      product,
      vendor,
      purchase,
      expense,
    };
  }
  async function effective(id: string) {
    const rows = await unwrapDb(ctx.db).execute(
      sql`SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e WHERE e.id=${id}`,
    );
    return rows.rows[0]?.category;
  }
  it("uses live nearest Product mapping before Purchase fallback and preserves explicit purpose", async () => {
    const f = await fixture();
    expect(await effective(f.expense.id)).toBe(f.clothing.id);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "ProductCategory" SET "spendingCategoryId"=${f.electronics.id} WHERE id=${f.root.id}`,
    );
    expect(await effective(f.expense.id)).toBe(f.electronics.id);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "spendingCategoryId"=${f.gifts.id} WHERE id=${f.expense.id}`,
    );
    expect(await effective(f.expense.id)).toBe(f.gifts.id);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "ProductCategory" SET "spendingCategoryId"=${f.clothing.id} WHERE id=${f.root.id}`,
    );
    expect(await effective(f.expense.id)).toBe(f.gifts.id);
  });
  it("lets a reviewed block stop ancestor defaults while retaining deliberate Purchase fallback", async () => {
    const f = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "ProductCategory" SET "spendingCategoryMode"='blocked' WHERE id=${f.child.id}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "spendingCategoryId"=NULL WHERE id=${f.purchase.id}`,
    );
    expect(await effective(f.expense.id)).toBeNull();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "spendingCategoryId"=${f.gifts.id} WHERE id=${f.purchase.id}`,
    );
    expect(await effective(f.expense.id)).toBe(f.gifts.id);
  });
  it("scopes correlated category quality reads to the selected Expense basket", async () => {
    const f = await fixture();
    const rows = await unwrapDb(ctx.db).execute(sql`
      SELECT allocation.* FROM "Expense" selected
      CROSS JOIN LATERAL (${expenseSpendingAllocationSql(sql`ARRAY[selected.id]::uuid[]`)}) allocation
      WHERE selected.id=${f.expense.id}
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      expenseId: f.expense.id,
      spendingCategoryId: f.clothing.id,
      amount: 60,
    });
  });
});
