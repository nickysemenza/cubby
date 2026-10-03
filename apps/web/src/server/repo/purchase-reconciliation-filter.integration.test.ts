import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { setDataException } from "./data-quality/exceptions";
import { purchaseList } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

// The `purchasesNotReconciling` Problem filters `reconciliation=mismatch`. That
// worklist must be the `paperwork_mismatch` gap (declared binding), so a
// recorded `expected_mismatch` exception removes a purchase from it.
describe("purchase reconciliation=mismatch filter", () => {
  const ctx = withTestDb();

  const makePurchase = async (
    label: string,
    statedTotal: number | null,
    cost: number | null,
  ) => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Reconcile fixture ${label}`,
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      statedTotal,
    });
    if (cost !== null) {
      await insertWithShortcode(ctx.db, "expense", {
        purchaseId: purchase.id,
        name: `Line ${label}`,
        cost,
        date: "2026-09-01",
        costType: "services",
        trade: "other",
      });
    }
    return purchase;
  };

  const mismatchIds = async () =>
    (
      await purchaseList(ctx.db, { reconciliation: "mismatch" }, [], {
        pageIndex: 0,
        pageSize: 50,
      })
    ).data.map((row) => row.id);

  it("lists mismatches, omits other verdicts, and honours recorded exceptions", async () => {
    const mismatch = await makePurchase("mismatch", 100, 50);
    const excepted = await makePurchase("excepted", 100, 40);
    const match = await makePurchase("match", 100, 100);
    const noStated = await makePurchase("no-stated", null, 30);
    const lineless = await makePurchase("lineless", 100, null);

    const before = await mismatchIds();
    expect(before).toEqual(
      expect.arrayContaining([mismatch.shortcode, excepted.shortcode]),
    );
    for (const other of [match, noStated, lineless])
      expect(before).not.toContain(other.shortcode);

    await setDataException(
      ctx.db,
      {
        entityId: excepted.shortcode,
        check: "paperwork_mismatch",
        reason: "expected_mismatch",
        note: "Receipt rounding residual verified by hand.",
      },
      ctx.actor,
    );

    const after = await mismatchIds();
    expect(after).toContain(mismatch.shortcode);
    expect(after).not.toContain(excepted.shortcode);
  });
});

// The Expenses, Reconciles and Settlement cells print server-composed text
// (`display.labelPath`) so no client re-derives the verdict.
describe("purchase list display labels", () => {
  const ctx = withTestDb();

  it("composes the expense count, reconciliation verdict and settlement status", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Label fixture vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      statedTotal: 100,
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Label line",
      cost: 50,
      date: "2026-09-01",
      costType: "services",
      trade: "other",
    });
    const { data } = await purchaseList(
      ctx.db,
      { reconciliation: "mismatch" },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    const row = data.find((candidate) => candidate.id === purchase.shortcode);
    expect(row?.expenseCountLabel).toBe("1");
    expect(row?.reconciliationLabel).toBe("Needs review -$50.00");
    expect(row?.financialReconciliationLabel).toMatch(/ · 0$/);
  });
});
