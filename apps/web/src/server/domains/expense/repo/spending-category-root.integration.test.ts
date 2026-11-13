import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { ExpenseAnalyzeOut, ExpenseFilters } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { nullableWholeCentToMinor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import { unwrapDb } from "~/server/db/helpers";
import { expense, product, productCategory } from "~/server/db/schema";
import { expenseAnalyzeWorkflow } from "~/server/domains/expense/operations/expense.server";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { expenseScaffold } from "./lookup";

const ctx = withTestDb();

const line = (
  name: string,
  cost: number,
  lineKind: ExpenseLineKind,
  links: Pick<
    typeof expense.$inferInsert,
    "purchaseId" | "spendingCategoryId"
  > = {},
) =>
  insertWithShortcode(ctx.db, "expense", {
    name: `synthetic root ${name}`,
    cost: nullableWholeCentToMinor(cost),
    lineKind,
    date: "2026-09-20",
    costType: "materials",
    trade: "other",
    future: false,
    ...links,
  });

const fixture = async () => {
  const home = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic home root",
  });
  const repairs = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic repairs child",
    parentId: home.id,
  });
  const travel = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic travel root",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic root vendor",
  });
  const order = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
  });
  const shippingOnly = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
  });
  await line("child item", 30, "principal", {
    purchaseId: order.id,
    spendingCategoryId: repairs.id,
  });
  await line("travel item", 10, "principal", {
    purchaseId: order.id,
    spendingCategoryId: travel.id,
  });
  await line("uncategorized item", 20, "principal", { purchaseId: order.id });
  // Split 3 / 1 / 2 by the principals' 30 / 10 / 20 weights.
  await line("tax", 6, "tax", { purchaseId: order.id });
  await line("unknown role", 5, "unclassified", { purchaseId: order.id });
  await line("child credit", -4, "principal", {
    spendingCategoryId: repairs.id,
  });
  // A Purchase with no principal line: its default share has no category.
  await line("lone shipping", 7, "shipping", { purchaseId: shippingOnly.id });
  return { home, repairs, travel };
};

const analyze = (filters: ExpenseFilters) =>
  expenseAnalyzeWorkflow(ctx.db, {
    filters: { search: "synthetic root", ...filters },
    rowDimension: "spendingCategory",
    spendingCategoryRollup: "root",
    comparison: "none",
  });

const netByRow = (analysis: ExpenseAnalyzeOut) => {
  if (analysis.status !== "ready") throw new Error(analysis.status);
  return Object.fromEntries(
    analysis.cells.map((cell) => [cell.rowKey, cell.current.net]),
  );
};

describe("expense.analyze root Spending Category roll-up", () => {
  it("keeps Product Category own spend, subtree scopes and truthful remainders on the same cent shares", async () => {
    const root = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic identity root",
    });
    const child = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic identity child",
      parentId: root.output.id,
    });
    const removed = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic deleted identity",
    });
    const identity = (name: string, categoryId: typeof root.output.id | null) =>
      createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name, categoryId }),
        ctx.actor,
      );
    const rootProduct = await identity(
      "Synthetic direct root Product",
      root.output.id,
    );
    const childProduct = await identity(
      "Synthetic child Product",
      child.output.id,
    );
    const noCategoryProduct = await identity(
      "Synthetic categoryless Product",
      null,
    );
    const removedCategoryProduct = await identity(
      "Synthetic deleted-category Product",
      removed.output.id,
    );
    const removedProduct = await identity(
      "Synthetic deleted Product",
      root.output.id,
    );
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic identity vendor",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-20",
    });
    const principal = (
      name: string,
      cost: number,
      productId?: typeof rootProduct.id,
    ) =>
      createRepoEntity(ctx, "expense", {
        name: `Synthetic identity axis ${name}`,
        cost,
        date: "2026-09-20",
        lineKind: "principal",
        trade: "other",
        future: false,
        productId: productId ?? null,
        purchaseId:
          productId === rootProduct.id || productId === childProduct.id
            ? purchase.output.id
            : null,
      });
    await principal("root item", 10, rootProduct.id);
    await principal("child item", 20, childProduct.id);
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic identity axis tax",
      cost: 3,
      date: "2026-09-20",
      lineKind: "tax",
      future: false,
      purchaseId: purchase.output.id,
    });
    await principal("categoryless", 2, noCategoryProduct.id);
    await principal("deleted category", 2, removedCategoryProduct.id);
    await principal("deleted product", 2, removedProduct.id);
    await principal("productless", 2);
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic identity axis unresolved",
      cost: 2,
      date: "2026-09-20",
      lineKind: "unclassified",
      future: false,
    });
    const emptyPurchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-20",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: emptyPurchase.output.id,
      name: "Synthetic identity axis shipping",
      cost: 2,
      date: "2026-09-20",
      lineKind: "shipping",
      future: false,
    });
    // Deleted references are historical evidence that supported writes cannot create.
    await unwrapDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, removedProduct.entityId));
    await unwrapDb(ctx.db)
      .update(productCategory)
      .set({ deletedAt: new Date() })
      .where(eq(productCategory.id, removed.entityId));
    const analyzeIdentity = (filters: ExpenseFilters = {}) =>
      expenseAnalyzeWorkflow(ctx.db, {
        filters: { search: "Synthetic identity axis", ...filters },
        rowDimension: "productCategory",
        comparison: "none",
        spendingCategoryRollup: "none",
      });
    const result = await analyzeIdentity();
    expect(netByRow(result)).toEqual({
      [root.output.id]: 11,
      [child.output.id]: 22,
      __uncategorized_product__: 2,
      __deleted_category__: 2,
      __deleted_product__: 2,
      __productless__: 2,
      __unclassified__: 2,
      __no_principal__: 2,
    });
    expect(result).toMatchObject({
      totals: {
        scope: { current: { net: 45 } },
        grid: { current: { net: 45 } },
      },
      reconciliation: { tail: { current: { net: 0 } } },
    });
    expect(
      netByRow(await analyzeIdentity({ productCategoryId: root.output.id })),
    ).toEqual({ [root.output.id]: 11, [child.output.id]: 22 });
    expect(
      netByRow(
        await analyzeIdentity({
          productCategoryId: root.output.id,
          includeSubProductCategories: false,
        }),
      ),
    ).toEqual({ [root.output.id]: 11 });
    expect(
      netByRow(
        await analyzeIdentity({ productCategoryPresenceFilter: "none" }),
      ),
    ).toHaveProperty("__productless__", 2);
    expect(
      netByRow(
        await analyzeIdentity({
          productCategoryId: root.output.id,
          productCategoryPresenceFilter: "none",
          includeSubProductCategories: false,
        }),
      ),
    ).toHaveProperty(root.output.id, 11);
    const excluded = await analyzeIdentity({
      productCategoryIdExclude: child.output.id,
    });
    expect(excluded).toMatchObject({
      totals: { scope: { current: { net: 22 } } },
    });
    const all = await analyzeIdentity({
      productCategoryId: [root.output.id, child.output.id],
      productCategoryIdMatch: "all",
      includeSubProductCategories: false,
    });
    expect(all).toMatchObject({ totals: { scope: { current: { net: 3 } } } });
    if (result.status !== "ready") return;
    for (const bucket of result.rows) {
      // Every live identity bucket opens the Ledger on its own assigned category.
      if (!bucket.filter.productCategory) continue;
      const filters: ExpenseFilters = {
        productCategoryId: testShortcode(
          "productCategory",
          bucket.filter.productCategory,
        ),
        includeSubProductCategories: false,
      };
      const where = await expenseScaffold.prepareWhere(ctx.db, {
        search: "Synthetic identity axis",
        ...filters,
      });
      const ledger = await unwrapDb(ctx.db)
        .select({ name: expense.name })
        .from(expense)
        .where(where);
      expect(ledger.map((row) => row.name).sort()).toEqual(
        [
          `Synthetic identity axis ${bucket.key === root.output.id ? "root" : "child"} item`,
          "Synthetic identity axis tax",
        ].sort(),
      );
    }
    for (const remainder of [
      "productless",
      "deleted_product",
      "uncategorized_product",
      "deleted_category",
      "unclassified",
      "no_principal",
    ] as const) {
      const scoped = await analyzeIdentity({
        productCategoryRemainder: remainder,
      });
      expect(netByRow(scoped)).toEqual({ [`__${remainder}__`]: 2 });
      const where = await expenseScaffold.prepareWhere(ctx.db, {
        search: "Synthetic identity axis",
        productCategoryRemainder: remainder,
      });
      expect(
        await unwrapDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense)
          .where(where),
      ).toEqual([{ cost: 2 }]);
    }
  });

  it("rolls child spend to its root and keeps Uncategorized and Unclassified distinct", async () => {
    const { home, travel } = await fixture();
    const analysis = await analyze({});
    expect(netByRow(analysis)).toEqual({
      [home.shortcode]: 29,
      [travel.shortcode]: 11,
      uncategorized: 29,
      unclassified: 5,
    });
    expect(analysis).toMatchObject({
      status: "ready",
      totals: {
        scope: { current: { net: 74 } },
        grid: { current: { net: 74 } },
      },
      reconciliation: { tail: { current: { net: 0 } } },
    });
    if (analysis.status !== "ready") return;
    expect(
      Object.fromEntries(analysis.rows.map((row) => [row.key, row.filter])),
    ).toEqual({
      [home.shortcode]: {
        spendingCategory: home.shortcode,
        includeSubSpendingCategories: "true",
      },
      [travel.shortcode]: {
        spendingCategory: travel.shortcode,
        includeSubSpendingCategories: "true",
      },
      uncategorized: {
        spendingCategory: "__none__",
        lineKind: expect.not.stringContaining("unclassified"),
      },
      unclassified: { lineKind: "unclassified" },
    });
  });

  it("reconciles to the filtered net without moving an adjustment share", async () => {
    const { repairs, travel } = await fixture();
    const byTravel = await analyze({
      spendingCategoryId: [testShortcode("spendingCategory", travel.shortcode)],
    });
    expect(netByRow(byTravel)).toEqual({ [travel.shortcode]: 11 });
    expect(byTravel).toMatchObject({
      totals: { scope: { current: { net: 11 } } },
      reconciliation: { tail: { current: { net: 0 } } },
    });

    const bySubtree = await analyze({
      spendingCategoryId: [
        testShortcode("spendingCategory", repairs.shortcode),
      ],
    });
    expect(Object.values(netByRow(bySubtree))).toEqual([29]);

    const unclassifiedOnly = await analyze({ lineKind: ["unclassified"] });
    expect(netByRow(unclassifiedOnly)).toEqual({ unclassified: 5 });
  });
});
