import type { FinancialReconciliationSummary } from "@cubby/schemas/financial-transaction";

export interface FinancialReconciliationInput {
  expenseTotal: number;
  unpricedExpenseCount: number;
  transactionCount: number;
  postedTransactionCount: number;
  outstandingTransactionCount: number;
  postedTotal: number;
  projectedTotal: number;
}

const cents = (value: number) => Math.round(value * 100);

/**
 * Compute settlement status from already-aggregated live, non-void rows.
 * Purchase reads and Problems detection share this function so their
 * comparison total, cent rounding, status, and delta cannot drift.
 */
export function calculateFinancialReconciliation(
  input: FinancialReconciliationInput,
): FinancialReconciliationSummary {
  const expenseTotal = Number(input.expenseTotal);
  const transactionCount = Number(input.transactionCount);
  const postedTransactionCount = Number(input.postedTransactionCount);
  const outstandingTransactionCount = Number(input.outstandingTransactionCount);
  const postedTotal = Number(input.postedTotal);
  const projectedTotal = Number(input.projectedTotal);
  const comparable =
    Number(input.unpricedExpenseCount) === 0 && transactionCount > 0;
  const comparisonTotal =
    outstandingTransactionCount > 0 ? projectedTotal : postedTotal;
  const delta = comparable ? comparisonTotal - expenseTotal : null;

  return {
    status: !comparable
      ? "unknown"
      : outstandingTransactionCount > 0 &&
          cents(projectedTotal) === cents(expenseTotal)
        ? "pending"
        : outstandingTransactionCount === 0 &&
            cents(postedTotal) === cents(expenseTotal)
          ? "match"
          : "mismatch",
    transactionCount,
    postedTransactionCount,
    outstandingTransactionCount,
    postedTotal,
    projectedTotal,
    delta,
  };
}
