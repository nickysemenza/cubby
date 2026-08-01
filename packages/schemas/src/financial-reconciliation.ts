import { z } from "zod";

export const financialReconciliationStatus = z.enum([
  "unknown",
  "pending",
  "match",
  "mismatch",
]);
export type FinancialReconciliationStatus = z.infer<
  typeof financialReconciliationStatus
>;

export const financialReconciliationSummary = z.object({
  status: financialReconciliationStatus,
  transactionCount: z.number().int().nonnegative(),
  postedTransactionCount: z.number().int().nonnegative(),
  outstandingTransactionCount: z.number().int().nonnegative(),
  postedTotal: z.number().finite(),
  projectedTotal: z.number().finite(),
  /** Posted refund evidence only; negative under the settlement sign convention. */
  postedRefundTotal: z.number().finite(),
  delta: z.number().finite().nullable(),
});
export type FinancialReconciliationSummary = z.infer<
  typeof financialReconciliationSummary
>;
