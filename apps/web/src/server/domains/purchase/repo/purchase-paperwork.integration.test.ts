import { splitExpenseInput } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { moneyToMinor, nullableWholeCentToMinor } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { loadDataQualities as readDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";

import { purchaseScaffold, readPurchaseById, splitExpense } from "./purchase";

// A friend credit is spending evidence but not a change to the vendor receipt.
// This boundary guards hydration/filter disagreement and accidental money loss.
describe("vendor paperwork and household reimbursements", () => {
  const ctx = withTestDb();
  const loadDataQualities: typeof readDataQualities = async (...args) => {
    await publishQualityFixtures(ctx.db, "purchase");
    return readDataQualities(...args);
  };
  it("keeps the receipt at 120 and net spending at 80 across reads and filters", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Paperwork fixture restaurant",
    });
    const purchase = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      statedTotal: moneyToMinor(120),
    });
    for (const [name, cost, economicRole] of [
      ["Vendor bill", 120, "vendor"],
      ["Friend share returned", -40, "reimbursement"],
    ] as const) {
      await createPurchaseEventRecord(ctx.db, "expense", {
        lineKind: "principal",
        purchaseId: purchase.id,
        name,
        cost: nullableWholeCentToMinor(cost),
        date: "2026-09-01",
        economicRole,
        costType: "services",
        trade: "other",
      });
    }
    const detail = await readPurchaseById(ctx.db, purchase.id);
    expect(detail).toMatchObject({
      expenseTotal: 80,
      statedTotal: 120,
      reconciliation: "match",
    });
    const list = await purchaseScaffold.read(ctx.db, {
      filters: { reconciliation: "match" },
      sorts: [],
      pagination: {
        pageIndex: 0,
        pageSize: 25,
      },
    });
    expect(list.data.map((row) => row.id)).toContain(detail.id);
    const quality = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "paperwork_mismatch",
    );
  });
  it("preserves reimbursement classification, category override and booking lineage when split", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Split reimbursement category",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Split reimbursement fixture",
    });
    const purchase = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      statedTotal: moneyToMinor(120),
      defaultTrade: "other",
    });
    await createPurchaseEventRecord(ctx.db, "expense", {
      lineKind: "principal",
      name: "Original bill",
      purchaseId: purchase.id,
      cost: 12000n,
      date: "2026-09-01",
      costType: "services",
      trade: "other",
    });
    const bookingTransactionCode = testShortcode(
      "financialTransaction",
      "split-reimbursement",
    );
    const credit = await createPurchaseEventRecord(ctx.db, "expense", {
      lineKind: "principal",
      name: "Friend reimbursement",
      purchaseId: purchase.id,
      cost: -4000n,
      date: "2026-09-01",
      costType: "services",
      trade: "other",
      economicRole: "reimbursement",
      lineBasis: "allocation",
      spendingCategoryId: category.id,
      bookingTransactionCode,
    });
    const { items } = await splitExpense(
      ctx.db,
      splitExpenseInput.parse({
        expenseId: credit.shortcode,
        parts: [
          {
            lineKind: "principal",
            name: "First share",
            cost: -25,
            costType: "services",
            trade: "other",
          },
          {
            lineKind: "principal",
            name: "Second share",
            cost: -15,
            costType: "services",
            trade: "other",
          },
        ],
      }),
      ctx.actor,
    );
    for (const item of items)
      expect(item).toMatchObject({
        economicRole: "reimbursement",
        lineBasis: "allocation",
        bookingTransactionCode,
        spendingCategoryId: category.shortcode,
      });
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 80,
      reconciliation: "match",
    });
  });
});
