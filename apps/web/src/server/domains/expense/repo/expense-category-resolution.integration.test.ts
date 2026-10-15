import { tradeSchema } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { expenseSpendingCategoryResolutionSql } from "./expense-category-resolution";
import { effectiveExpenseTradeSql } from "./expense-inheritance";
import { expenseSpendingAllocationSql } from "./expense-spending-allocation";

const categoryPlanNode = z.object({
  "Relation Name": z.string().optional(),
  "Actual Loops": z.number().optional(),
  get Plans() {
    return z.array(categoryPlanNode).optional();
  },
});

// Real SQL regressions: mixed retailer purchases must not flatten Product
// classifications, blocked ancestors must remain unknown, and restaurant
// context must classify Food without classifying unrelated merchandise. Bulk
// allocations must not repeat the taxonomy walk for every principal Expense.
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
      lineKind: "principal",
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
      sql`SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category,
        ${expenseSpendingCategoryResolutionSql("e")}->>'categoryId' AS explained_category
        FROM "Expense" e WHERE e.id=${id}`,
    );
    expect(rows.rows[0]?.category).toBe(rows.rows[0]?.explained_category);
    return rows.rows[0]?.category;
  }
  it("resolves category IDs without executing provenance projections", async () => {
    const f = await fixture();
    const result = await unwrapDb(ctx.db)
      .execute(sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e`);
    const plan = z
      .array(z.object({ Plan: categoryPlanNode }))
      .parse(result.rows[0]?.["QUERY PLAN"])[0]!.Plan;
    let catalogLookups = 0;
    const inspect = (node: z.infer<typeof categoryPlanNode>) => {
      if (node["Relation Name"] === "SpendingCategory")
        catalogLookups += node["Actual Loops"] ?? 0;
      node.Plans?.forEach(inspect);
    };
    inspect(plan);
    // The four candidate catalog checks validate overrides and inherited IDs;
    // scalar reads must not also load labels and fallback provenance.
    expect(catalogLookups).toBeLessThanOrEqual(4);
    expect(await effective(f.expense.id)).toBe(f.clothing.id);
  });
  it("groups derived category and trade by the same database expression", async () => {
    await fixture();
    const category = effectiveExpenseSpendingCategorySql("e");
    const trade = effectiveExpenseTradeSql("e");
    const rows = await unwrapDb(ctx.db)
      .execute(sql`SELECT ${category} AS category, ${trade} AS trade, COUNT(*) AS count
      FROM "Expense" e GROUP BY ${category}, ${trade}`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("shares category ancestry across principal allocations and draft mappings", async () => {
    const f = await fixture();
    const ids = [f.expense.id];
    for (let index = 0; index < 12; index++) {
      const line = await insertWithShortcode(ctx.db, "expense", {
        name: `Shared taxonomy fixture ${index}`,
        cost: 1,
        date: "2026-09-01",
        costType: "materials",
        lineKind: "principal",
        productId: f.product.id,
        purchaseId: f.purchase.id,
      });
      ids.push(line.id);
    }
    const otherRoot = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Shared taxonomy electronics",
      spendingCategoryMode: "mapped",
      spendingCategoryId: f.electronics.id,
    });
    const otherProduct = await insertWithShortcode(ctx.db, "product", {
      name: "Shared taxonomy radio",
      manufacturer: "Fixture",
      categoryId: otherRoot.id,
    });
    const otherLine = await insertWithShortcode(ctx.db, "expense", {
      name: "Shared taxonomy unrelated root",
      cost: 3,
      date: "2026-09-01",
      costType: "materials",
      lineKind: "principal",
      productId: otherProduct.id,
      purchaseId: f.purchase.id,
    });
    ids.push(otherLine.id);
    const allocation = expenseSpendingAllocationSql(ids);
    const result = await unwrapDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${allocation}`,
    );
    const plan = z
      .array(z.object({ Plan: categoryPlanNode }))
      .parse(result.rows[0]?.["QUERY PLAN"])[0]!.Plan;
    let taxonomyScans = 0;
    const inspect = (node: z.infer<typeof categoryPlanNode>) => {
      if (node["Relation Name"] === "ProductCategory")
        taxonomyScans += node["Actual Loops"] ?? 0;
      node.Plans?.forEach(inspect);
    };
    inspect(plan);
    expect(taxonomyScans).toBeLessThanOrEqual(8);
    const stored = await unwrapDb(ctx.db).execute(allocation);
    expect(stored.rows).toHaveLength(ids.length);
    expect(
      stored.rows.every(
        (row) =>
          row.spendingCategoryId ===
          (row.expenseId === otherLine.id ? f.electronics.id : f.clothing.id),
      ),
    ).toBe(true);
    const preview = await unwrapDb(ctx.db).execute(
      expenseSpendingAllocationSql(ids, {
        productCategories: [
          {
            id: f.root.id,
            parentId: f.child.id,
            spendingCategoryMode: "mapped",
            spendingCategoryId: f.gifts.id,
          },
        ],
      }),
    );
    expect(preview.rows).toHaveLength(ids.length);
    expect(
      preview.rows.every(
        (row) =>
          row.spendingCategoryId ===
          (row.expenseId === otherLine.id ? f.electronics.id : f.gifts.id),
      ),
    ).toBe(true);
  });

  it("does not inherit Purchase category or trade for an unresolved receipt role", async () => {
    const f = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "defaultTrade"=${tradeSchema.enum.other} WHERE id=${f.purchase.id}`,
    );
    const unresolved = await insertWithShortcode(ctx.db, "expense", {
      name: "Unresolved adjustment evidence",
      date: "2026-09-01",
      cost: 1.25,
      costType: "services",
      lineKind: "unclassified",
      trade: null,
      future: false,
      purchaseId: f.purchase.id,
    });
    const rows = await unwrapDb(ctx.db).execute(sql`
      SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category,
        ${effectiveExpenseTradeSql("e")} AS trade
      FROM "Expense" e WHERE e.id=${unresolved.id}
    `);
    expect(rows.rows[0]).toEqual({ category: null, trade: null });
  });
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
