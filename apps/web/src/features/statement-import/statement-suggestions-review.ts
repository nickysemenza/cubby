import type { assessmentReviewInput } from "@cubby/schemas/assessment";
import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import type { FinancialTransactionShortcode } from "@cubby/schemas/identifiers";
import type {
  StatementSuggestionOut,
  StatementTransactionApplication,
  StatementTransactionAction,
  statementTransactionField,
} from "@cubby/schemas/statement-suggestion";
import type { z } from "zod";

export type ReviewItem = z.input<typeof assessmentReviewInput>;
export type StatementTransactionField = z.infer<
  typeof statementTransactionField
>;

/** The member's pick for one suggestion, before it becomes a review item. */
export type StatementChoice = {
  action: StatementTransactionAction;
  /** Attach target; absent means the first candidate. */
  transactionId?: FinancialTransactionShortcode;
  fields?: StatementTransactionField[];
  kindOverride?: FinancialTransactionKind;
};

/**
 * The application the server applies for a choice. A create lists every
 * candidate as rejected: the server refuses a create while any possible
 * existing transaction is still live.
 */
function statementApplication(
  suggestion: StatementSuggestionOut,
  choice: StatementChoice,
): StatementTransactionApplication {
  const kindOverride =
    choice.kindOverride && choice.kindOverride !== suggestion.create?.kind
      ? choice.kindOverride
      : undefined;
  return {
    kind: "statement_transaction",
    action: choice.action,
    ...(choice.action === "attach" && choice.transactionId
      ? { transactionId: choice.transactionId }
      : {}),
    fields: choice.action === "attach" ? (choice.fields ?? []) : [],
    ...(choice.action === "create" && kindOverride ? { kindOverride } : {}),
    rejectedCandidateIds:
      choice.action === "create"
        ? suggestion.candidates.map((candidate) => candidate.transactionId)
        : [],
  };
}

/** Whether the application is exactly the recommendation (Correct), not a correction (Wrong). */
function isRecommendedAsIs(
  suggestion: StatementSuggestionOut,
  application: StatementTransactionApplication,
): boolean {
  if (application.action !== suggestion.recommended) return false;
  if (application.kindOverride || application.fields.length) return false;
  if (application.action === "attach")
    return (
      !application.transactionId ||
      application.transactionId === suggestion.candidates[0]?.transactionId
    );
  return true;
}

/** One `assessment.reviewBatch` item applying the member's choice. */
export function applyItem(
  suggestion: StatementSuggestionOut,
  choice: StatementChoice = { action: suggestion.recommended },
): ReviewItem {
  const application = statementApplication(suggestion, choice);
  const asIs = isRecommendedAsIs(suggestion, application);
  return {
    assessmentId: suggestion.assessmentId,
    operationId: crypto.randomUUID(),
    verdict: asIs ? "correct" : "wrong",
    correction: asIs
      ? { present: false }
      : { present: true, value: application },
    intent: "apply",
    expectedFingerprint: suggestion.fingerprint,
    reason: null,
    evidence: null,
    application,
  };
}

/** Dismiss: settle without applying; the charge stays suppressed on every later pass. */
export function dismissItem(suggestion: StatementSuggestionOut): ReviewItem {
  return {
    assessmentId: suggestion.assessmentId,
    operationId: crypto.randomUUID(),
    verdict: "dismissed",
    correction: { present: false },
    intent: "history",
    expectedFingerprint: suggestion.fingerprint,
    reason: null,
    evidence: null,
    suppression: {
      scope: "statement_transaction",
      candidateKey: `${suggestion.source}:${suggestion.chargeKey}`,
      fingerprint: suggestion.fingerprint,
    },
  };
}
