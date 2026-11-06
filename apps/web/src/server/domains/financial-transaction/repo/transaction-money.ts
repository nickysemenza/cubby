import { minorToMoney } from "@cubby/shared";

import type { financialTransaction } from "~/server/db/schema";
export type FinancialTransactionDollars = Omit<
  typeof financialTransaction.$inferSelect,
  "amount"
> & { amount: number };
/** Keep dollar-number receipts and retained fingerprint key order at the read boundary. */
export function transactionDollars<T extends { amount: bigint }>(
  row: T,
): Omit<T, "amount"> & { amount: number } {
  return { ...row, amount: minorToMoney(row.amount) };
}
