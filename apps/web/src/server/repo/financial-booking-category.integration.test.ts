import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  financialTransaction,
  purchase as purchaseTable,
} from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createFinancialAccount } from "./financial-account";
import {
  commitFinancialBooking,
  previewFinancialBooking,
} from "./financial-booking";
import {
  previewFinancialBookingCorrection,
  commitFinancialBookingCorrection,
} from "./financial-booking-correction";
import { createFinancialTransaction } from "./financial-transaction";
import { getPurchaseByID } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

// SQL-backed approval regressions: displayed defaults must not become overrides, and bank
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
    const transaction = async (amount: number) => {
      const saved = await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.output.id,
          kind: amount < 0 ? "refund" : "purchase",
          status: "posted",
          amount,
          postedDate: "2026-09-01",
          merchant: "Booking fixture vendor",
          sourceCategory: "Synthetic source dining",
        }),
        ctx.actor,
      );
      // Legacy stored category evidence must not become a new ledger override.
      await getDb(ctx.db)
        .update(financialTransaction)
        .set({ spendingCategoryId: category.id })
        .where(eq(financialTransaction.shortcode, saved.output.id));
      return saved;
    };
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
    return { category, purchase, vendor, transaction, line, book };
  }
  it("books displayed category defaults without materializing Purchase or Expense overrides", async () => {
    const { purchase, category, book } = await fixture();
    const { preview, result } = await book(25);
    expect(preview.categoryOverride).toBeNull();
    expect(preview.spendingCategoryId).toBe(category.shortcode);
    const storedPurchase = await getDb(ctx.db).query.purchase.findFirst({
      where: (row, { eq }) => eq(row.id, purchase.id),
    });
    expect(storedPurchase?.spendingCategoryId).toBeNull();
    if (!result.expenseId) throw new Error("Expected aggregate Expense");
    const [storedLine] = await getDb(ctx.db)
      .select({
        spendingCategoryId: expense.spendingCategoryId,
        cost: expense.cost,
      })
      .from(expense)
      .where(eq(expense.shortcode, result.expenseId));
    expect(storedLine).toEqual({ spendingCategoryId: null, cost: 25 });
  });
  it("books unclassified spending and replays after a later classification edit", async () => {
    const { purchase, transaction } = await fixture();
    const source = await transaction(35);
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ spendingCategoryId: null })
      .where(eq(financialTransaction.shortcode, source.output.id));
    const review = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        purchaseId: purchase.shortcode,
      }),
    );
    expect(review.spendingCategoryId).toBeNull();
    const saved = await commitFinancialBooking(ctx.db, review, ctx.actor);
    const laterCategory = await insertWithShortcode(
      ctx.db,
      "spendingCategory",
      { name: "Later reviewed classification" },
    );
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ spendingCategoryId: laterCategory.id })
      .where(eq(financialTransaction.shortcode, source.output.id));
    expect(await commitFinancialBooking(ctx.db, review, ctx.actor)).toEqual({
      ...saved,
      replayed: true,
    });
  });
  it("applies explicit category only to a new aggregate, including a new Purchase", async () => {
    const { category: sourceCategory, vendor, transaction } = await fixture();
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Explicit aggregate classification",
    });
    const source = await transaction(45);
    const review = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        vendorId: vendor.shortcode,
        spendingCategoryId: category.shortcode,
      }),
    );
    const saved = await commitFinancialBooking(ctx.db, review, ctx.actor);
    if (!saved.expenseId) throw new Error("Expected aggregate Expense");
    const storedPurchase = await getDb(ctx.db).query.purchase.findFirst({
      where: (row, { eq }) => eq(row.shortcode, saved.purchaseId),
    });
    const storedLine = await getDb(ctx.db).query.expense.findFirst({
      where: eq(expense.shortcode, saved.expenseId),
    });
    expect(storedPurchase?.spendingCategoryId).toBeNull();
    expect(storedLine?.spendingCategoryId).toBe(category.id);
    const storedSource = await getDb(
      ctx.db,
    ).query.financialTransaction.findFirst({
      where: eq(financialTransaction.shortcode, source.output.id),
    });
    expect(storedSource?.spendingCategoryId).toBe(sourceCategory.id);
  });
  it("links itemized spending without overwriting differing classifications", async () => {
    const { category, purchase, line, transaction } = await fixture();
    const receiptLine = await line(25);
    const otherCategory = await insertWithShortcode(
      ctx.db,
      "spendingCategory",
      { name: "Reviewed item classification" },
    );
    await getDb(ctx.db)
      .update(expense)
      .set({ spendingCategoryId: otherCategory.id })
      .where(eq(expense.id, receiptLine.id));
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ spendingCategoryId: otherCategory.id })
      .where(eq(purchaseTable.id, purchase.id));
    const source = await transaction(25);
    const review = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        purchaseId: purchase.shortcode,
        spendingCategoryId: category.shortcode,
      }),
    );
    expect(review.action).toBe("link_existing");
    await commitFinancialBooking(ctx.db, review, ctx.actor);
    const storedLine = await getDb(ctx.db).query.expense.findFirst({
      where: eq(expense.id, receiptLine.id),
    });
    const storedPurchase = await getDb(ctx.db).query.purchase.findFirst({
      where: (row, { eq }) => eq(row.id, purchase.id),
    });
    expect(storedLine?.spendingCategoryId).toBe(otherCategory.id);
    expect(storedPurchase?.spendingCategoryId).toBe(otherCategory.id);
  });
  it("reattaches a reimbursement to an unclassified Purchase without erasing its explicit line category", async () => {
    const { category, vendor, purchase, transaction } = await fixture();
    const source = await transaction(-15);
    const booked = await commitFinancialBooking(
      ctx.db,
      await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: source.output.id,
          vendorId: vendor.shortcode,
          spendingCategoryId: category.shortcode,
          economicRole: "reimbursement",
        }),
      ),
      ctx.actor,
    );
    const review = await previewFinancialBookingCorrection(ctx.db, {
      transactionId: source.output.id,
      action: { kind: "attach_reimbursement", purchaseId: purchase.shortcode },
    });
    expect(review.categoryName).toBeNull();
    await commitFinancialBookingCorrection(ctx.db, review, ctx.actor);
    if (!booked.expenseId) throw new Error("Expected reimbursement Expense");
    const storedLine = await getDb(ctx.db).query.expense.findFirst({
      where: eq(expense.shortcode, booked.expenseId),
    });
    expect(storedLine?.purchaseId).toBe(purchase.id);
    expect(storedLine?.spendingCategoryId).toBe(category.id);
  });
  it("refuses first approval when the classification catalog changes after review", async () => {
    const { purchase, transaction } = await fixture();
    const source = await transaction(25);
    const review = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        purchaseId: purchase.shortcode,
      }),
    );
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "New classification available after review",
    });
    await expect(
      commitFinancialBooking(ctx.db, review, ctx.actor),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    const live = await getDb(ctx.db).query.expense.findMany({
      where: (row, { and, eq, isNull }) =>
        and(eq(row.purchaseId, purchase.id), isNull(row.deletedAt)),
    });
    expect(live).toEqual([]);
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
