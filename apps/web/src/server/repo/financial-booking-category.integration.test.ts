import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { loadDataQualities } from "./data-quality/hydrate";
import { createFinancialAccount } from "./financial-account";
import {
  commitFinancialBooking,
  previewFinancialBooking,
} from "./financial-booking";
import { createFinancialTransaction } from "./financial-transaction";
import { getPurchaseByID } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

// SQL-backed approval regressions: inherited category must persist, and bank
// credits must not silently reuse original charges, discounts, or spent refunds.
describe("reviewed booking category and refund capacity", () => {
  const ctx = withTestDb();
  async function fixture() {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Booking fixture dining",
      evidenceExpectation: "not_expected",
      productExpectation: "not_expected",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Booking fixture vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      defaultTrade: "other",
    });
    const account = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Booking fixture cash",
        identity: { kind: "cash" },
      }),
      ctx.actor,
    );
    const transaction = async (amount: number) =>
      createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.output.id,
          kind: amount < 0 ? "refund" : "purchase",
          status: "posted",
          amount,
          postedDate: "2026-09-01",
          merchant: "Booking fixture vendor",
          spendingCategoryId: category.shortcode,
        }),
        ctx.actor,
      );
    const line = async (
      cost: number,
      lineKind: "principal" | "discount" = "principal",
    ) =>
      insertWithShortcode(ctx.db, "expense", {
        purchaseId: purchase.id,
        name: "Booking fixture line",
        cost,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        lineKind,
        lineBasis: "item_line",
        economicRole: "vendor",
      });
    const book = async (amount: number) => {
      const source = await transaction(amount);
      const preview = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: source.output.id,
          purchaseId: purchase.shortcode,
        }),
      );
      const result = await commitFinancialBooking(ctx.db, preview, ctx.actor);
      return { preview, result };
    };
    return { category, purchase, line, book };
  }
  it("persists the approved inherited category for an existing empty Purchase", async () => {
    const { purchase, category, book } = await fixture();
    const { preview } = await book(25);
    expect(preview.categoryOverride).toBeNull();
    expect(await getPurchaseByID(ctx.db, purchase.id)).toMatchObject({
      spendingCategoryId: category.shortcode,
      expenseTotal: 25,
    });
    const quality = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "purchase_spending_category",
    );
  });
  it("records a new vendor credit against an existing positive receipt", async () => {
    const { purchase, line, book } = await fixture();
    await line(120);
    const { preview, result } = await book(-40);
    expect(preview.action).toBe("create_aggregate");
    expect(result.expenseId).not.toBeNull();
    expect(await getPurchaseByID(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 80,
    });
  });
  it("reuses an already itemized negative receipt once, then books the next refund", async () => {
    const { purchase, line, book } = await fixture();
    await line(120);
    await line(-10);
    const first = await book(-10);
    expect(first.preview.action).toBe("link_existing");
    expect(first.result.expenseId).toBeNull();
    const second = await book(-40);
    expect(second.preview.action).toBe("create_aggregate");
    expect(await getPurchaseByID(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 70,
    });
  });
  it("does not reuse a receipt discount as a later vendor refund", async () => {
    const { purchase, line, book } = await fixture();
    await line(120);
    await line(-5, "discount");
    await book(115);
    const { preview } = await book(-5);
    expect(preview.action).toBe("create_aggregate");
    expect(await getPurchaseByID(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 110,
    });
  });
});
