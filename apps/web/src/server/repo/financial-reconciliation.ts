import type { FinancialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";
import type { PurchaseFinancialAggregate } from "~/server/repo/purchase-financial-aggregates";

/**
 * The settlement-side aggregate every caller gets verbatim from
 * `loadPurchaseFinancialAggregates`, plus the two expense-side fields each
 * caller derives itself.
 *
 * Spelled as an intersection with `PurchaseFinancialAggregate` rather than
 * restating its six fields: all three call sites spread `...financial` straight
 * in, so the loader's shape and this function's shape cannot drift apart
 * without a compile error.
 */
export type FinancialReconciliationInput = PurchaseFinancialAggregate & {
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
};

/**
 * The `settleableExpenseTotal` / `settleableUnpricedExpenseCount` above, as
 * hand-qualified raw SQL, so the "INCURRED spend only" rule has one definition
 * instead of one per query shape. `purchaseAlias` is the enclosing query's
 * Purchase alias, quoted as it appears there — `'"Purchase"'` for a Drizzle
 * select, `'p'` inside a hand-written statement.
 *
 * Raw strings rather than interpolated Drizzle columns: a cross-table
 * correlated reference gets prefix-stripped by `buildSelection` and silently
 * self-joins. See `correlated()` in `database-helpers/query.ts`, which is how a
 * Drizzle select field wraps the result.
 *
 * **Contract: the enclosing query owns Purchase liveness.** These fragments
 * filter Expense liveness and the incurred-only rule, and nothing else — a
 * correlated scalar can only ever return a number, so it has no way to *drop* a
 * soft-deleted purchase's row. Every caller already restricts to live purchases
 * in its own WHERE or join.
 *
 * `repo/expense/match.ts` deliberately does NOT use these; see the note there.
 */
export const settleableExpenseTotalSql = (purchaseAlias: string) =>
  `(SELECT COALESCE(sum(se_e."cost"), 0)::double precision FROM "Expense" se_e
     WHERE se_e."purchaseId" = ${purchaseAlias}."id"
       AND se_e."deletedAt" IS NULL
       AND se_e."future" = false)`;

export const settleableUnpricedExpenseCountSql = (purchaseAlias: string) =>
  `(SELECT count(*)::int FROM "Expense" se_e
     WHERE se_e."purchaseId" = ${purchaseAlias}."id"
       AND se_e."cost" IS NULL
       AND se_e."deletedAt" IS NULL
       AND se_e."future" = false)`;

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
