import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { ExpenseAnalyzeOut, ExpenseFilters } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { expense } from "~/server/db/schema";
import { expenseAnalyzeWorkflow } from "~/server/domains/expense/operations.server";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
    cost,
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
