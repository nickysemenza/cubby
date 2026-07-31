import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { unsafePurchaseId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "./expense";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
} from "./financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  linkExpensesToPurchase,
  mergePurchases,
} from "./purchase";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { findOrCreateVendor, getVendorByID } from "./vendor";

const account = (
  name: string,
  aliases = [] as {
    source: string;
    alias: string;
    externalAccountId: string | null;
  }[],
) =>
  financialAccountCreateInput.parse({
    name,
    identity: {
      kind: "credit_card",
      issuer: null,
      network: "visa",
      last4: "1234",
    },
    sourceAliases: aliases,
  });

describe("financial repositories — critical invariants", () => {
  const ctx = withTestDb();

  it("blocks account deletion, rejects cross-row source collisions, and preserves purchase-only updates", async () => {
    const a = (
      await createFinancialAccount(
        ctx.db,
        account("Visa", [
          { source: "statement", alias: "Visa", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      )
    ).output;
    await expect(
      createFinancialAccount(
        ctx.db,
        account("Duplicate", [
          { source: "statement", alias: "Other", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT" },
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Finance test vendor");
    const purchase = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId: (await getVendorByID(ctx.db, vendorId)).id,
          orderId: "finance-1",
        }),
        ctx.actor,
      )
    ).output;
    const tx = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: purchase.id,
          kind: "purchase",
          status: "pending",
          amount: 10,
          sourceRefs: [{ source: "statement", externalId: "tx-1" }],
        }),
        ctx.actor,
      )
    ).output;
    await expect(
      deleteFinancialAccounts(ctx.db, [a.id], ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS" },
    });
    await expect(
      createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          kind: "purchase",
          status: "pending",
          amount: 10,
          sourceRefs: [{ source: "statement", externalId: "tx-1" }],
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT" },
    });
    await expect(
      updateFinancialTransaction(
        ctx.db,
        tx.id,
        { status: "posted" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED" },
    });
    const updated = await updateFinancialTransaction(
      ctx.db,
      tx.id,
      { purchaseId: null },
      ctx.actor,
    );
    expect(updated.output.purchaseId).toBeNull();
  });

  it("reconciles settlement separately from Expense spend and re-points/detaches transactions", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Reconcile Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Reconcile Vendor");
    const { getVendorByID } = await import("./vendor");
    const vendor = await getVendorByID(ctx.db, vendorId);
    const p1 = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id, orderId: null }),
        ctx.actor,
      )
    ).output;
    const p2 = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id, orderId: "settle-2" }),
        ctx.actor,
      )
    ).output;
    const expense = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "settlement line",
        trade: "other",
        costType: "materials",
        cost: 10,
        vendor: "Reconcile Vendor",
        orderId: null,
        future: false,
      }),
      ctx.actor,
    );
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: p1.id, expenseIds: [expense.output.id] },
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: p1.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 10,
      }),
      ctx.actor,
    );
    const p1Uuid = unsafePurchaseId(
      (await resolveLiveShortcode(ctx.db, p1.id, "purchase"))!,
    );
    expect(
      (await getPurchaseByID(ctx.db, p1Uuid)).financialReconciliation.status,
    ).toBe("match");
    await mergePurchases(
      ctx.db,
      { keepId: p1.id, mergeIds: [p2.id] },
      ctx.actor,
    );
    await deletePurchases(ctx.db, [p1.id], ctx.actor);
    const txs = await (
      await import("./financial-transaction")
    ).listFinancialTransactions(ctx.db, { purchasePresence: "none" }, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(txs.data.some((row) => row.purchaseId === null)).toBe(true);
  });

  it("reports unknown, pending, and mismatch in cents while excluding void and deleted evidence", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Status Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Status Vendor");
    const vendor = await getVendorByID(ctx.db, vendorId);

    const makePurchaseWithExpense = async (
      orderId: string,
      cost: number | null,
    ) => {
      const purchase = (
        await createPurchase(
          ctx.db,
          purchaseCreateInput.parse({ vendorId: vendor.id, orderId }),
          ctx.actor,
        )
      ).output;
      const line = await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name: `line ${orderId}`,
          trade: "other",
          costType: "materials",
          cost,
          vendor: vendor.name,
          orderId,
          future: false,
        }),
        ctx.actor,
      );
      await linkExpensesToPurchase(
        ctx.db,
        { purchaseId: purchase.id, expenseIds: [line.output.id] },
        ctx.actor,
      );
      const uuid = unsafePurchaseId(
        (await resolveLiveShortcode(ctx.db, purchase.id, "purchase"))!,
      );
      return { purchase, uuid };
    };

    const unknown = await makePurchaseWithExpense("status-unknown", 10);
    expect(
      (await getPurchaseByID(ctx.db, unknown.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 0 });

    const unpriced = await makePurchaseWithExpense("status-unpriced", null);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: unpriced.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 5,
      }),
      ctx.actor,
    );
    expect(
      (await getPurchaseByID(ctx.db, unpriced.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 1 });

    const pending = await makePurchaseWithExpense("status-pending", 51.49);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: pending.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 60.56,
      }),
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: pending.purchase.id,
        kind: "refund",
        status: "expected",
        transactionDate: "2026-01-02",
        amount: -9.07,
      }),
      ctx.actor,
    );
    expect(
      (await getPurchaseByID(ctx.db, pending.uuid)).financialReconciliation,
    ).toMatchObject({
      status: "pending",
      postedTotal: 60.56,
      projectedTotal: 51.49,
      outstandingTransactionCount: 1,
    });

    const mismatch = await makePurchaseWithExpense("status-mismatch", 10);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: mismatch.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-03",
        amount: 12,
      }),
      ctx.actor,
    );
    const voided = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: mismatch.purchase.id,
          kind: "adjustment",
          status: "void",
          amount: 999,
        }),
        ctx.actor,
      )
    ).output;
    const deleted = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: mismatch.purchase.id,
          kind: "adjustment",
          status: "posted",
          postedDate: "2026-01-04",
          amount: -2,
        }),
        ctx.actor,
      )
    ).output;
    await deleteFinancialTransactions(ctx.db, [deleted.id], ctx.actor);
    const result = await getPurchaseByID(ctx.db, mismatch.uuid);
    expect(result.expenseTotal).toBe(10);
    expect(result.financialReconciliation).toMatchObject({
      status: "mismatch",
      transactionCount: 1,
      postedTotal: 12,
      projectedTotal: 12,
      delta: 2,
    });
    expect(voided.status).toBe("void");
  });
});
