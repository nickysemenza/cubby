import type { PurchaseId } from "@cubby/schemas/identifiers";
import type { Database } from "~/server/db";
import { financialTransactionAllocation } from "~/server/db/schema";
import { insertAndReturn } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/**
 * Insert a settlement transaction the way the write path would: with its
 * allocation, not just its mirror column.
 *
 * Fixtures that reach past `createFinancialTransaction` straight to
 * `insertWithShortcode` used to produce a linked transaction by setting
 * `purchaseId` alone. Since settlement reads derive from
 * `FinancialTransactionAllocation`, such a row is now linked in name only — it
 * contributes nothing to any purchase's reconciliation — so those fixtures were
 * asserting settlement behaviour against a transaction that settles nothing.
 *
 * Use this wherever a test needs a transaction that actually settles a Purchase.
 * A transaction with no `purchaseId` needs no allocation and can keep using
 * `insertWithShortcode` directly.
 */
export async function insertSettlementTransaction(
  db: Database,
  values: Parameters<typeof insertWithShortcode<"financialTransaction">>[2] & {
    purchaseId: PurchaseId;
    amount: number;
  },
) {
  const transaction = await insertWithShortcode(
    db,
    "financialTransaction",
    values,
  );
  await insertAndReturn(db, financialTransactionAllocation, {
    transactionId: transaction.id,
    purchaseId: values.purchaseId,
    amount: values.amount,
  });
  return transaction;
}
