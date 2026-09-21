import type { FinancialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";
import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";

import { cents } from "~/server/repo/money";
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

/**
 * The settlement total compared with incurred expenses. Outstanding expected
 * or pending rows make the projected total authoritative; otherwise only
 * posted rows count. Keep this fragment shared by the verdict and exception
 * fingerprint so a changed charge amount cannot inherit an exception for a
 * different financial delta.
 */
export const purchaseFinancialComparisonTotalSql = (purchaseAlias: string) =>
  `(CASE WHEN (
    SELECT count(DISTINCT a."transactionId")
    FROM "FinancialTransactionAllocation" a
    JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
    WHERE a."purchaseId" = ${purchaseAlias}."id" AND a."deletedAt" IS NULL
      AND ft."deletedAt" IS NULL AND ft."kind" IN (${purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", ")})
      AND ft."status" IN ('expected', 'pending')
  ) > 0 THEN (
    SELECT COALESCE(sum(a."amount"), 0)::double precision FROM "FinancialTransactionAllocation" a
    JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
    WHERE a."purchaseId" = ${purchaseAlias}."id" AND a."deletedAt" IS NULL
      AND ft."deletedAt" IS NULL AND ft."kind" IN (${purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", ")})
      AND ft."status" <> 'void'
  ) ELSE (
    SELECT COALESCE(sum(a."amount"), 0)::double precision FROM "FinancialTransactionAllocation" a
    JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
    WHERE a."purchaseId" = ${purchaseAlias}."id" AND a."deletedAt" IS NULL
      AND ft."deletedAt" IS NULL AND ft."kind" IN (${purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", ")})
      AND ft."status" = 'posted'
  ) END)`;

/**
 * Correlated SQL form of `calculateFinancialReconciliation(...).status ===
 * "mismatch"`, before a reasoned `settlement_mismatch` exception is applied.
 * The raw verdict remains available to data quality and detail reads: accepting
 * a documented discrepancy must not falsify the actual bank/ledger delta.
 */
export const purchaseFinancialMismatchRawSql = (purchaseAlias: string) => `
  ${settleableUnpricedExpenseCountSql(purchaseAlias)} = 0
  AND (
    SELECT count(DISTINCT a."transactionId")
    FROM "FinancialTransactionAllocation" a
    JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
    WHERE a."purchaseId" = ${purchaseAlias}."id"
      AND a."deletedAt" IS NULL
      AND ft."deletedAt" IS NULL
      AND ft."kind" IN (${purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", ")})
      AND ft."status" <> 'void'
  ) > 0
  AND floor(${purchaseFinancialComparisonTotalSql(purchaseAlias)} * 100 + 0.5)
    IS DISTINCT FROM floor((${settleableExpenseTotalSql(purchaseAlias)}) * 100 + 0.5)`;

/** Input-scoped snapshot for a settlement-mismatch exception. */
export const purchaseFinancialMismatchFingerprintRawSql = (
  purchaseAlias: string,
) =>
  `'settlement_mismatch:' || concat_ws('|',
    COALESCE(to_jsonb(${purchaseFinancialMismatchRawSql(purchaseAlias)})::text, 'null'),
    COALESCE(to_jsonb(${purchaseFinancialComparisonTotalSql(purchaseAlias)})::text, 'null'),
    COALESCE(to_jsonb(${settleableExpenseTotalSql(purchaseAlias)})::text, 'null'),
    COALESCE(to_jsonb(${settleableUnpricedExpenseCountSql(purchaseAlias)})::text, 'null')
  )`;

/**
 * The canonical worklist predicate. A settlement mismatch stays a raw financial
 * fact, but an active, evidence-bound exception removes it from the actionable
 * Problems list. This deliberately names one check rather than adding a cents
 * tolerance: every accepted difference remains explicit and goes stale when
 * the Purchase's evidence clock advances.
 */
export const purchaseFinancialMismatchSql = (purchaseAlias: string) => `
  (${purchaseFinancialMismatchRawSql(purchaseAlias)})
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(${purchaseAlias}."dataExceptions") exception
    WHERE exception->>'check' = 'settlement_mismatch'
      AND exception->>'fingerprint' = ${purchaseFinancialMismatchFingerprintRawSql(purchaseAlias)}
  )`;

/**
 * `kind = 'refund' AND status = 'posted'` — the atom behind every posted-refund
 * figure. It had been spelled out five times (two grouped scans, two correlated
 * scalars, one hand-written detector query), which is exactly the shape of
 * drift this file exists to prevent.
 *
 * **Liveness is the caller's**, because the two shapes handle it differently: a
 * grouped scan already filters `deletedAt` in its WHERE, so repeating it inside
 * a `FILTER (WHERE …)` would be noise, while a correlated scalar has no WHERE to
 * inherit and gets it from `postedRefundTotalSql` below.
 *
 * **Deliberately NOT account-liveness-filtered.** `loadPurchaseDataQualities`
 * used to compute its refund total through an INNER JOIN to a live
 * `FinancialAccount` while the other four spellings did not. A refund happened
 * regardless of whether its account row was later retired, so the join is wrong
 * here and the four unfiltered spellings were right. Invisible until now — there
 * are zero soft-deleted accounts in production — but it would have surfaced as
 * two purchase rows disagreeing about the same refund. Coverage is the opposite
 * case and keeps the join; see `settlementReferencePredicate`.
 */
export const postedRefundPredicate = (ftxAlias: string) =>
  `${ftxAlias}."kind" = 'refund' AND ${ftxAlias}."status" = 'posted'`;

/**
 * The posted-refund total for one Purchase, as a correlated scalar. Same
 * raw-string reasoning as `settleableExpenseTotalSql`, and the same contract:
 * the enclosing query owns Purchase liveness.
 */
export const postedRefundTotalSql = (purchaseAlias: string) =>
  `(SELECT COALESCE(sum(pr_a."amount"), 0)::double precision
     FROM "FinancialTransactionAllocation" pr_a
     JOIN "FinancialTransaction" pr_ft ON pr_ft."id" = pr_a."transactionId"
     WHERE pr_a."purchaseId" = ${purchaseAlias}."id"
       AND pr_a."deletedAt" IS NULL
       AND pr_ft."deletedAt" IS NULL
       AND ${postedRefundPredicate("pr_ft")})`;

/**
 * What makes a settlement row count as *evidence* for the
 * `settlement_reference` data-quality check: posted, of a settlement kind, and
 * carrying either an external source reference or a cash account (cash leaves no
 * statement to reference, so the account itself is the evidence).
 *
 * **Account liveness belongs here**, unlike in `postedRefundPredicate` — the
 * rule literally reads `identity->>'kind'`, so it cannot be evaluated without a
 * live account row. Carrying it in the predicate (rather than on each caller's
 * join) is what lets the grouped scan LEFT JOIN — it needs unfiltered rows for
 * its refund sum — while still applying the liveness rule to coverage alone.
 *
 * `settlementReferenceAbsentSql` repeats the same condition on its JOIN. That
 * redundancy is deliberate: the `cubby/require-soft-delete-filter` oxlint
 * rule scans raw SQL text and cannot see through this function call, so
 * without the visible predicate it fails the build — correctly, since it has
 * no way to prove the filter exists. Keep both.
 */
export const settlementReferencePredicate = (
  ftxAlias: string,
  accountAlias: string,
) =>
  `${ftxAlias}."status" = 'posted'
     AND ${ftxAlias}."kind" IN (${purchaseSettlementKinds
       .map((kind) => `'${kind}'`)
       .join(", ")})
     AND ${accountAlias}."deletedAt" IS NULL
     AND (
       jsonb_array_length(${ftxAlias}."sourceRefs") > 0
       OR ${accountAlias}."identity"->>'kind' = 'cash'
     )`;

/**
 * "This Purchase has no qualifying settlement evidence" — the `NOT EXISTS` half
 * of the `settlement_reference` gap, shared by the badge and the list filter so
 * the two cannot disagree about the same row.
 */
export const settlementReferenceAbsentSql = (purchaseAlias: string) =>
  `NOT EXISTS (
    SELECT 1 FROM "FinancialTransactionAllocation" sr_a
    JOIN "FinancialTransaction" sr_ft
      ON sr_ft."id" = sr_a."transactionId" AND sr_ft."deletedAt" IS NULL
    JOIN "FinancialAccount" sr_fa
      ON sr_fa."id" = sr_ft."accountId" AND sr_fa."deletedAt" IS NULL
    WHERE sr_a."purchaseId" = ${purchaseAlias}."id"
      AND sr_a."deletedAt" IS NULL
      AND ${settlementReferencePredicate("sr_ft", "sr_fa")}
  )`;

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
