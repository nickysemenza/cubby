import {
  reusableStatementSpendingAnswers,
  statementAnswerMatches,
} from "@cubby/schemas/statement-answers";
import {
  statementAnswers,
  type StatementAnswers,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";

import { canonicalJson } from "~/server/lib/canonical-json";

/** The statement evidence actually presented to all three decision features. */
export function statementLabelSubject(judgment: StatementTransactionJudgment) {
  const create = judgment.create;
  return create
    ? {
        descriptor: create.rawDescription,
        merchant: create.merchant,
        category: create.sourceCategory,
        date: judgment.statementDate,
        amount: create.amount,
        status: judgment.providerStatus,
      }
    : null;
}

export function statementCandidateSubject(
  candidate: StatementTransactionJudgment["candidates"][number],
) {
  return {
    descriptor: candidate.rawDescription,
    merchant: candidate.merchant,
    date: candidate.postedDate ?? candidate.transactionDate,
    amount: candidate.amount,
    status: candidate.status,
  };
}

/** Frozen feature versions, independent of the automatic publication policy. */
export const statementAnswerVersions = {
  kind: { "statement-transaction-kind": "2026-11-12.1" },
  counterparty: { "statement-counterparty": "2026-10-18.1" },
  candidates: { "statement-charge-identity": "2026-11-12.1" },
} as const;

/** Newest compatible answer wins independently for each question. */
export function mergeStatementAnswers(
  judgment: StatementTransactionJudgment,
  history: readonly unknown[],
  isLoan = false,
): StatementAnswers {
  const result = statementAnswers.parse({});
  const statement = statementLabelSubject(judgment);
  for (const data of history) {
    const parsed = statementAnswers.safeParse(data);
    if (!parsed.success) continue;
    const answers = parsed.data;
    for (const part of ["kind", "counterparty"] as const) {
      if (
        !result[part] &&
        statementAnswerMatches(
          answers[part],
          statement,
          statementAnswerVersions[part],
        )
      )
        Object.assign(result, { [part]: answers[part] });
    }
    for (const candidate of judgment.candidates) {
      const answer = answers.candidates[candidate.transactionId];
      if (
        !result.candidates[candidate.transactionId] &&
        statementAnswerMatches(
          answer,
          { statement, transaction: statementCandidateSubject(candidate) },
          statementAnswerVersions.candidates,
        )
      )
        result.candidates[candidate.transactionId] = answer!;
    }
    const spending = judgment.create
      ? reusableStatementSpendingAnswers(judgment.create, isLoan, answers)
      : {};
    if (spending.escrow) result.escrow ??= spending.escrow;
    if (!result.merchant) {
      if (spending.merchant) result.merchant = spending.merchant;
    } else if (
      !result.merchant.support &&
      spending.merchant?.support &&
      statementAnswerMatches(
        result.merchant.identity,
        spending.merchant.identity.input,
        spending.merchant.identity.versions,
      ) &&
      canonicalJson(result.merchant.identity.value) ===
        canonicalJson(spending.merchant.identity.value)
    )
      result.merchant.support = spending.merchant.support;
  }
  return result;
}
