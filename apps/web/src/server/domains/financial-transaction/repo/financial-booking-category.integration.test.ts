import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  purchase as purchaseTable,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { createLedgerTransfer } from "~/server/domains/ledger-transfer/repo";
import { readPurchaseById } from "~/server/domains/purchase/repo/purchase";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { merchantVendorInferenceFor } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";

import {
  bookFinancialTransaction,
  commitFinancialBooking,
  previewFinancialBooking,
} from "./financial-booking";
import {
  previewFinancialBookingCorrection,
  commitFinancialBookingCorrection,
} from "./financial-booking-correction";
import { financialTransactionRepository } from "./financial-transaction";

// SQL-backed approval regressions: displayed defaults must not become overrides, and bank
// credits must not silently reuse original charges, discounts, or spent refunds.
describe("reviewed booking category and refund capacity", () => {
  const ctx = withTestDb();
  async function fixture() {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Booking fixture dining",
      itemizationExpectation: "not_expected",
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
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic booking member",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Booking fixture cash",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
    });
    const transaction = async (amount: number) => {
      const saved = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: amount < 0 ? "refund" : "purchase",
        status: "posted",
        amount,
        postedDate: "2026-09-01",
        merchant: "Booking fixture vendor",
        sourceCategory: "Synthetic source dining",
      });
      // Legacy stored category evidence must not become a new ledger override.
      await getDb(ctx.db)
        .update(financialTransaction)
        .set({ spendingCategoryId: category.id })
        .where(eq(financialTransaction.shortcode, saved.output.id));
      return saved;
    };
    const line = async (
      cost: number,
      lineKind: "principal" | "discount" | "unclassified" = "principal",
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
    return { category, purchase, vendor, transaction, line, book, owner };
  }
  it("books an identified statement Vendor without creating confirmation feedback", async () => {
    const { vendor, transaction, book } = await fixture();
    await book(12);
    const source = await transaction(15);
    const preview = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({ transactionId: source.output.id }),
    );
    expect(preview).toMatchObject({
      vendorId: vendor.shortcode,
      confirmsMerchant: false,
    });
    const result = await commitFinancialBooking(ctx.db, preview, ctx.actor);
    expect(result.purchaseId).toBeTruthy();
    expect(
      await merchantVendorInferenceFor(ctx.db, "Booking fixture vendor"),
    ).toMatchObject({
      status: "suggested",
      candidates: [
        { vendorId: vendor.shortcode, supportingTransactionCount: 1 },
      ],
    });
  });

  // A purchaser override must identify a live member; household card authority
  // may allow an unknown individual but never a household override.
  it("defaults a bare Purchase to its live account member and rejects a household purchaser override", async () => {
    const { vendor, transaction, owner } = await fixture();
    const source = await transaction(17);
    const household = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic booking household",
      kind: "household",
    });
    await expect(
      previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: source.output.id,
          vendorId: vendor.shortcode,
          purchaserId: household.output.id,
        }),
      ),
    ).rejects.toThrow(/member/i);
    const preview = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        vendorId: vendor.shortcode,
      }),
    );
    expect(preview.purchaserId).toBe(owner.output.id);
    const saved = await commitFinancialBooking(ctx.db, preview, ctx.actor);
    const stored = await getDb(ctx.db).query.purchase.findFirst({
      where: eq(purchaseTable.shortcode, saved.purchaseId),
    });
    expect(stored?.purchaserOverrideId).not.toBeNull();
  });
  it("refuses replay when linked itemized spending no longer covers its settlement", async () => {
    const { purchase, transaction, line } = await fixture();
    const receipt = await line(25);
    const source = await transaction(25);
    const review = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: source.output.id,
        purchaseId: purchase.shortcode,
      }),
    );
    await commitFinancialBooking(ctx.db, review, ctx.actor);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 1 })
      .where(eq(expense.id, receipt.id));
    await expect(
      commitFinancialBooking(ctx.db, review, ctx.actor),
    ).rejects.toThrow(/cover|capacity|spending/i);
  });
  it("refuses settlement while unresolved signed receipt lines could duplicate money", async () => {
    const { purchase, transaction, line } = await fixture();
    await line(-25, "unclassified");
    for (const amount of [-25, 25]) {
      const source = await transaction(amount);
      await expect(
        previewFinancialBooking(
          ctx.db,
          financialBookingInput.parse({
            transactionId: source.output.id,
            purchaseId: purchase.shortcode,
          }),
        ),
      ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    }
    const stored = await getDb(ctx.db).query.expense.findMany({
      where: eq(expense.purchaseId, purchase.id),
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.cost).toBe(-25);
  });
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
  it("reattaches reimbursement, preserves categories and money, and converts only unchanged bookings", async () => {
    const { category, vendor, purchase, transaction, line, owner } =
      await fixture();
    await line(120);
    const source = await transaction(-40);
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
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 80,
    });

    const recipient = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic correction recipient",
      kind: "guest",
    });
    const transferReview = async (amount: number) => {
      const source = await transaction(amount);
      const booking = await commitFinancialBooking(
        ctx.db,
        await previewFinancialBooking(
          ctx.db,
          financialBookingInput.parse({
            transactionId: source.output.id,
            vendorId: vendor.shortcode,
            spendingCategoryId: category.shortcode,
            economicRole: "vendor",
          }),
        ),
        ctx.actor,
      );
      const expenseId = booking.expenseId;
      if (!expenseId) throw new Error("Expected generated booking Expense");
      const transfer = await createLedgerTransfer(
        ctx.db,
        buildEntity("ledgerTransfer", {
          fromPartyId: owner.output.id,
          toPartyId: recipient.output.id,
          amount,
          date: "2026-09-10",
        }),
        ctx.actor,
      );
      const review = await previewFinancialBookingCorrection(ctx.db, {
        transactionId: source.output.id,
        action: { kind: "convert_to_transfer", transferId: transfer.output.id },
      });
      return { source, expenseId, transfer, review };
    };
    const converted = await transferReview(20);
    await commitFinancialBookingCorrection(ctx.db, converted.review, ctx.actor);
    expect(
      await financialTransactionRepository.repository.get(
        kernelCtx(ctx),
        converted.source.output.id,
      ),
    ).toMatchObject({
      kind: "account_transfer",
      ledgerTransferId: converted.transfer.output.id,
      coverage: { booking: "not_applicable" },
    });
    expect(
      await getDb(ctx.db).query.expense.findFirst({
        where: eq(expense.shortcode, converted.expenseId),
      }),
    ).toMatchObject({ deletedAt: expect.any(Date) });

    const stale = await transferReview(25);
    await updateExpense(
      ctx.db,
      stale.expenseId,
      { notes: "Synthetic reviewed note change" },
      ctx.actor,
    );
    await expect(
      commitFinancialBookingCorrection(ctx.db, stale.review, ctx.actor),
    ).rejects.toThrow(/original booking was edited/);
    expect(
      await getDb(ctx.db).query.expense.findFirst({
        where: eq(expense.shortcode, stale.expenseId),
      }),
    ).toMatchObject({
      deletedAt: null,
      cost: 25,
      notes: "Synthetic reviewed note change",
    });
    expect(
      await getDb(ctx.db).query.financialTransaction.findFirst({
        where: eq(financialTransaction.id, stale.source.entityId),
      }),
    ).toMatchObject({ kind: "purchase", ledgerTransferId: null });
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
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
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
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
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
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 110,
    });
  });
});

// Agents booked reimbursements by hand-creating Expenses and setting
// FTX.purchaseId; finance.book_transaction runs the reviewed booking instead.
describe("finance.book_transaction", () => {
  const ctx = withTestDb();
  async function fixture() {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic shared lodge",
      aliases: ["SYNTHETIC LODGE CO"],
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      defaultTrade: "other",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Synthetic lodge stay",
      cost: 100,
      date: "2026-09-01",
      costType: "services",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic lodge payer",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic booking checking",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
    });
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      purchaseId: purchase.shortcode,
      kind: "purchase",
      status: "posted",
      amount: 100,
      postedDate: "2026-09-01",
      merchant: "SYNTHETIC LODGE CO",
    });
    const income = async (merchant = "SYNTHETIC LODGE CO") =>
      (
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: account.output.id,
          kind: "income",
          status: "posted",
          amount: -40,
          postedDate: "2026-09-05",
          merchant,
        })
      ).output.id;
    return { vendor, purchase, income };
  }
  const reimbursements = (
    purchaseId: NonNullable<typeof expense.$inferSelect.purchaseId>,
  ) =>
    getDb(ctx.db)
      .select({
        cost: expense.cost,
        economicRole: expense.economicRole,
        bookingTransactionCode: expense.bookingTransactionCode,
      })
      .from(expense)
      .where(eq(expense.purchaseId, purchaseId));

  it("books posted income as a reimbursement into an existing Purchase over MCP", async () => {
    const { purchase, income } = await fixture();
    const transactionId = await income();
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ itemizationExpectation: "required" })
      .where(eq(financialTransaction.shortcode, transactionId));
    const result = await callMcpTool(
      createMcpServer(),
      "finance",
      {
        action: "book_transaction",
        transactionId,
        purchaseId: purchase.shortcode,
        economicRole: "reimbursement",
      },
      kernelRequestContext(kernelCtx(ctx)),
    );
    expect(result.isError).not.toBe(true);
    expect(await reimbursements(purchase.id)).toContainEqual({
      cost: -40,
      economicRole: "reimbursement",
      bookingTransactionCode: transactionId,
    });
    const linked = await getDb(ctx.db)
      .select({ purchaseId: financialTransactionAllocation.purchaseId })
      .from(financialTransactionAllocation)
      .innerJoin(
        financialTransaction,
        eq(
          financialTransaction.id,
          financialTransactionAllocation.transactionId,
        ),
      )
      .where(eq(financialTransaction.shortcode, transactionId));
    expect(linked).toEqual([{ purchaseId: purchase.id }]);
    expect(await readPurchaseById(ctx.db, purchase.id)).toMatchObject({
      expenseTotal: 60,
      statedTotal: null,
      financialReconciliation: { status: "match", delta: 0 },
    });
    expect(
      await financialTransactionRepository.repository.get(
        kernelCtx(ctx),
        transactionId,
      ),
    ).toMatchObject({
      itemizationExpectation: "required",
      fieldResolutions: {
        itemizationExpectation: {
          mode: "allocated",
          storedValue: "required",
          value: "not_expected",
          fallbackValue: "not_expected",
          source: "reviewed reimbursement",
          sourceEntity: null,
          canReset: true,
        },
      },
    });
  });

  it("creates a lump Purchase for the merchant's Vendor when none is named", async () => {
    const { vendor, purchase, income } = await fixture();
    const transactionId = await income();
    const booked = await bookFinancialTransaction(
      ctx.db,
      financialBookingInput.parse({
        transactionId,
        economicRole: "reimbursement",
      }),
      ctx.actor,
    );
    expect(booked.purchaseId).not.toBe(purchase.shortcode);
    const [lump] = await getDb(ctx.db)
      .select({
        id: purchaseTable.id,
        vendorId: purchaseTable.vendorId,
        date: purchaseTable.date,
      })
      .from(purchaseTable)
      .where(eq(purchaseTable.shortcode, booked.purchaseId));
    expect(lump).toMatchObject({ vendorId: vendor.id, date: "2026-09-05" });
    expect(await reimbursements(lump!.id)).toEqual([
      {
        cost: -40,
        economicRole: "reimbursement",
        bookingTransactionCode: transactionId,
      },
    ]);
    // An unknown merchant is refused rather than inventing a Vendor.
    await expect(
      bookFinancialTransaction(
        ctx.db,
        financialBookingInput.parse({
          transactionId: await income("SYNTHETIC UNKNOWN PAYER"),
          economicRole: "reimbursement",
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("SYNTHETIC UNKNOWN PAYER"),
    });
  });

  it("refuses income without the reimbursement role", async () => {
    const { purchase, income } = await fixture();
    await expect(
      bookFinancialTransaction(
        ctx.db,
        financialBookingInput.parse({
          transactionId: await income(),
          purchaseId: purchase.shortcode,
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Classify this incoming credit explicitly as a reimbursement before booking it.",
    });
  });
});
