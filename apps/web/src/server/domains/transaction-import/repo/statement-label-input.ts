import {
  statementAnswers,
  type StatementAnswers,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";

import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

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

/** Candidate identity and model inputs, independent of rules and observation occurrences. */
export function statementLabelInputs(judgment: StatementTransactionJudgment) {
  return {
    statement: statementLabelSubject(judgment),
    candidates: judgment.candidates
      .map((candidate) => ({
        id: candidate.transactionId,
        input: statementCandidateSubject(candidate),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Frozen feature versions, independent of the automatic publication policy. */
export const statementAnswerVersions = {
  kind: { "statement-transaction-kind": "2026-11-12.1" },
  counterparty: { "statement-counterparty": "2026-10-18.1" },
  candidates: { "statement-charge-identity": "2026-11-12.1" },
} as const;

export function compatibleStatementAnswer(
  answer: { input: unknown; versions: unknown } | undefined,
  input: unknown,
  versions: unknown,
) {
  return (
    answer !== undefined &&
    canonicalJson(jsonSnapshot.parse(answer.input)) ===
      canonicalJson(jsonSnapshot.parse(input)) &&
    canonicalJson(jsonSnapshot.parse(answer.versions)) ===
      canonicalJson(jsonSnapshot.parse(versions))
  );
}

/** Newest compatible answer wins independently for each question. */
export function mergeStatementAnswers(
  judgment: StatementTransactionJudgment,
  history: readonly unknown[],
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
        compatibleStatementAnswer(
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
        compatibleStatementAnswer(
          answer,
          { statement, transaction: statementCandidateSubject(candidate) },
          statementAnswerVersions.candidates,
        )
      )
        result.candidates[candidate.transactionId] = answer!;
    }
    // Spending owns validation of its feature projections and versions.
    result.escrow ??= answers.escrow;
    result.merchant ??= answers.merchant;
  }
  return result;
}
