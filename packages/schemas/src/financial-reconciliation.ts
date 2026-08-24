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

/**
 * The reconciliation numbers, as a field map so other contract modules can
 * restate this shape without copying individual fields.
 *
 * Exported because `problems.ts` reports the same figures on its own detector
 * rows and used to hand-copy them, silently dropping every `.finite()` guard
 * below. Sharing the map is what keeps that from happening again.
 */
export const financialReconciliationFields = {
  transactionCount: z.number().int().nonnegative(),
  postedTransactionCount: z.number().int().nonnegative(),
  outstandingTransactionCount: z.number().int().nonnegative(),
  postedTotal: money.finite(),
  projectedTotal: money.finite(),
  /** Posted refund evidence only; negative under the settlement sign convention. */
  postedRefundTotal: money.finite(),
};

export const financialReconciliationSummary = z.object({
  status: financialReconciliationStatus,
  ...financialReconciliationFields,
  /**
   * Null exactly when the summary is not comparable — which is exactly when
   * `status` is "unknown" (see `calculateFinancialReconciliation`). Callers
   * that have already narrowed `status` can narrow this too.
   */
  delta: money.finite().nullable(),
});
export type FinancialReconciliationSummary = z.infer<
  typeof financialReconciliationSummary
>;
