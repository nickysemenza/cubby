import { seedBankTransaction } from "~/server/domains/financial-transaction/repo/bank.fixtures";
import { moneyToMinor } from "@cubby/shared";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import type { Database } from "~/server/db";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import type { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

/** Seed a reconciled transaction and its synthetic settlement allocation. */
export async function insertSettlementTransaction(
  db: Database,
  values: Omit<
    Parameters<typeof insertWithShortcode<"financialTransaction">>[2],
    "amount"
  > & {
    purchaseId: PurchaseId;
    amount: number;
  },
) {
  const transaction = await seedBankTransaction(db, {
    ...values,
    amount: moneyToMinor(values.amount),
  });
  await createPurchaseEventRecord(db, "FinancialTransactionAllocation", {
    transactionId: transaction.id,
    purchaseId: values.purchaseId,
    amountMinor: moneyToMinor(values.amount),
  });
  return transactionDollars(transaction);
}
