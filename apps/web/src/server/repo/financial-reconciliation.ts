import type { FinancialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";

export interface FinancialReconciliationInput {
  /**
   * The **incurred** expense total — `future: true` rows excluded.
   *
   * Deliberately not the Purchase's displayed `expenseTotal`, and named apart
   * from it so a caller can't pass the wrong one by habit. A planned expense
   * has not happened yet, so no settlement evidence for it can exist; counting
   * it here makes the comparison unsatisfiable and reports a mismatch for a
   * purchase that is behaving exactly as intended. That is not hypothetical —
   * an 11-payment venue contract with 3 posted payments read as a $107,982
   * mismatch until this excluded the 8 planned ones.
   *
   * Note the pre-existing `transactionCount > 0` guard below hides this on the
   * common shape: a purchase whose payments are ALL still planned has no
   * transactions at all, so it lands in `unknown` and never surfaced the bug.
   * It only appears once some payments have settled and some have not.
   *
   * ONE ASYMMETRY TO KNOW ABOUT. This excludes planned spend from the expense
   * side, but `projectedTotal` on the settlement side still includes expected
   * and pending transactions. So a payment recorded BOTH as a `future` Expense
   * AND as an outstanding FinancialTransaction would be dropped from one side
   * and kept on the other, and report a mismatch of its own amount. No purchase
   * does that today (checked: zero), and the schedule here is modelled purely
   * as future Expenses. If it ever starts happening, make the two sides
   * consistent — do not "fix" it by counting planned spend again, which is the
   * unsatisfiable comparison this exists to remove.
   */
  settleableExpenseTotal: number;
  /** Unpriced rows among the incurred expenses — same exclusion, same reason. */
  settleableUnpricedExpenseCount: number;
  transactionCount: number;
  postedTransactionCount: number;
  outstandingTransactionCount: number;
  postedTotal: number;
  projectedTotal: number;
  postedRefundTotal: number;
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
  const settleableExpenseTotal = Number(input.settleableExpenseTotal);
  const transactionCount = Number(input.transactionCount);
  const postedTransactionCount = Number(input.postedTransactionCount);
  const outstandingTransactionCount = Number(input.outstandingTransactionCount);
  const postedTotal = Number(input.postedTotal);
  const projectedTotal = Number(input.projectedTotal);
  const postedRefundTotal = Number(input.postedRefundTotal);
  const comparable =
    Number(input.settleableUnpricedExpenseCount) === 0 && transactionCount > 0;
  const comparisonTotal =
    outstandingTransactionCount > 0 ? projectedTotal : postedTotal;
  const delta = comparable ? comparisonTotal - settleableExpenseTotal : null;

  return {
    status: !comparable
      ? "unknown"
      : outstandingTransactionCount > 0 &&
          cents(projectedTotal) === cents(settleableExpenseTotal)
        ? "pending"
        : outstandingTransactionCount === 0 &&
            cents(postedTotal) === cents(settleableExpenseTotal)
          ? "match"
          : "mismatch",
    transactionCount,
    postedTransactionCount,
    outstandingTransactionCount,
    postedTotal,
    projectedTotal,
    postedRefundTotal,
    delta,
  };
}
