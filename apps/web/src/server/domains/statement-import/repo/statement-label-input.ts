import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";

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
