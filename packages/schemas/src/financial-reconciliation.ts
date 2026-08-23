import { z } from "zod";
import { money } from "./money";

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
  postedTotal: money.finite(),
  projectedTotal: money.finite(),
  /** Posted refund evidence only; negative under the settlement sign convention. */
  postedRefundTotal: money.finite(),
  delta: money.finite().nullable(),
});
export type FinancialReconciliationSummary = z.infer<
  typeof financialReconciliationSummary
>;
