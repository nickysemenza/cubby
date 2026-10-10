import { financialTransactionFiltersSchema } from "@cubby/schemas/financial-transaction";
import { spendingCategorySummarySchema } from "@cubby/schemas/spending-classification";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { listFinancialTransactions } from "./financial-transaction";
import { getPurchaseByID } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

// Public reads must retain line classification and never turn settlement amounts into item spend.
describe("live Expense category summaries", () => {
  const ctx = withTestDb();
  it("exposes mixed Purchase dollars and transaction context without invented dollars", async () => {
    const tools = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic tools",
    });
    const food = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic food",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic summary vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    for (const [name, cost, category] of [
      ["Synthetic tool", 30, tools],
      ["Synthetic food item", 20, food],
    ] as const)
      await insertWithShortcode(ctx.db, "expense", {
        name,
        cost,
        spendingCategoryId: category.id,
        purchaseId: purchase.id,
        date: "2026-09-20",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Sales tax",
      cost: 5,
      purchaseId: purchase.id,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
      lineKind: "tax",
    });
    const purchaseRead = await getPurchaseByID(ctx.db, purchase.id);
    const summary = spendingCategorySummarySchema.parse(
      purchaseRead.spendingCategorySummary,
    );
    expect(summary).toMatchObject({
      state: "mixed",
      lineCount: 3,
      categorizedLineCount: 3,
      uncategorizedLineCount: 0,
      complete: true,
      amountsKnown: true,
    });
    expect(summary.categories).toEqual(
      expect.arrayContaining([
        { id: tools.shortcode, name: tools.name, amount: 33 },
        { id: food.shortcode, name: food.name, amount: 22 },
      ]),
    );
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic summary cash",
      identity: { kind: "cash" },
    });
    const source = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 25,
      postedDate: "2026-09-20",
      allocations: [{ purchaseId: purchase.shortcode, amount: 25 }],
    });
    const transactionSummary = spendingCategorySummarySchema.parse(
      source.output.spendingCategorySummary,
    );
    expect(transactionSummary).toMatchObject({
      state: "mixed",
      lineCount: 3,
      complete: true,
      amountsKnown: false,
    });
    expect(transactionSummary.categories).toEqual(
      expect.arrayContaining([
        { id: tools.shortcode, name: tools.name, amount: null },
        { id: food.shortcode, name: food.name, amount: null },
      ]),
    );
    const listed = await listFinancialTransactions(
      ctx.db,
      financialTransactionFiltersSchema.parse({}),
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(
      listed.data.find((row) => row.id === source.output.id)
        ?.spendingCategorySummary,
    ).toEqual(transactionSummary);
    expect(
      purchaseRead.dataQuality.gaps.map((entry) => entry.check),
    ).not.toContain("purchase_spending_category");
    expect(
      source.output.dataQuality.gaps.map((entry) => entry.check),
    ).not.toContain("financial_transaction_spending_category");
  });
  it("distinguishes unknown adjustment weights from missing price or project context", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic known adjustment purpose",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic unpriced vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    for (const [name, cost, lineKind] of [
      ["Unpriced classified principal", null, "principal"],
      ["Unclassified tax", 5, "tax"],
    ] as const) {
      await insertWithShortcode(ctx.db, "expense", {
        name,
        cost,
        lineKind,
        spendingCategoryId: lineKind === "principal" ? category.id : null,
        purchaseId: purchase.id,
        date: "2026-09-20",
        costType: "materials",
      });
    }
    const summary = async () =>
      (await getPurchaseByID(ctx.db, purchase.id)).spendingCategorySummary;
    expect(await summary()).toMatchObject({
      state: "partial",
      categorizedLineCount: 1,
      uncategorizedLineCount: 1,
      complete: false,
      amountsKnown: false,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Automatic tax without known principal weights",
      cost: 2,
      lineKind: "tax",
      purchaseId: purchase.id,
      date: "2026-09-20",
      costType: "materials",
    });
    expect(await summary()).toMatchObject({
      state: "partial",
      categorizedLineCount: 1,
      uncategorizedLineCount: 2,
      complete: false,
      amountsKnown: false,
    });
  });
  it("keeps unclassified and unknown-cost lines visible without guessing a category", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic known purpose",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic summary vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Known line",
      cost: 20,
      spendingCategoryId: category.id,
      purchaseId: purchase.id,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Unclassified unknown cost",
      cost: null,
      purchaseId: purchase.id,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
    });
    const summary = spendingCategorySummarySchema.parse(
      (await getPurchaseByID(ctx.db, purchase.id)).spendingCategorySummary,
    );
    expect(summary).toEqual({
      state: "partial",
      categories: [{ id: category.shortcode, name: category.name, amount: 20 }],
      lineCount: 2,
      categorizedLineCount: 1,
      uncategorizedLineCount: 1,
      complete: false,
      amountsKnown: false,
    });
  });
});
