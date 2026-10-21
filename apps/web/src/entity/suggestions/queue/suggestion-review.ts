import type { assessmentReviewInput } from "@cubby/schemas/assessment";
import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import type { FinancialTransactionShortcode } from "@cubby/schemas/identifiers";
import type {
  StatementSuggestionOut,
  StatementTransactionAction,
  StatementTransactionApplication,
  statementTransactionField,
} from "@cubby/schemas/statement-suggestion";
import type {
  SuggestionActionVerb,
  SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import { omitBy } from "es-toolkit";
import type { z } from "zod";

export type ReviewItem = z.input<typeof assessmentReviewInput>;
export type StatementTransactionField = z.infer<
  typeof statementTransactionField
>;

/** The member's pick for one statement suggestion, before it becomes a review item. */
export type StatementChoice = {
  action: StatementTransactionAction;
  /** Attach target; absent means the first candidate. */
  transactionId?: FinancialTransactionShortcode;
  fields?: StatementTransactionField[];
  kindOverride?: FinancialTransactionKind;
  booking?: StatementTransactionApplication["booking"];
};

/** Whether the server offers `verb` on this row (owner-only verbs included). */
export const offers = (row: SuggestionListRow, verb: SuggestionActionVerb) =>
  row.actions.some((action) => action.verb === verb);

/**
 * The application the server applies for a choice. A create lists every
 * candidate as rejected: the server refuses a create while any possible
 * existing transaction is still live.
 */
export function statementApplication(
  suggestion: StatementSuggestionOut,
  choice: StatementChoice,
): StatementTransactionApplication {
  const kindOverride =
    choice.kindOverride && choice.kindOverride !== suggestion.create?.kind
      ? choice.kindOverride
      : undefined;
  const target =
    choice.transactionId ?? suggestion.candidates[0]?.transactionId;
  // Draft controls clear choices with undefined; Feedback correction values
  // must contain ordinary JSON while preserving explicit standalone nulls.
  const booking = choice.booking
    ? {
        ...omitBy(choice.booking, (value) => value === undefined),
        rejectedPurchaseIds: choice.booking.rejectedPurchaseIds ?? [],
      }
    : undefined;
  return {
    kind: "statement_transaction",
    action: choice.action,
    // An attach always names its target, even with one candidate: the server
    // refuses an unnamed one when several candidates are live, and a target
    // read at review time cannot drift to another candidate later.
    ...(choice.action === "attach" && target ? { transactionId: target } : {}),
    fields: choice.action === "attach" ? (choice.fields ?? []) : [],
    ...(choice.action === "create" && kindOverride ? { kindOverride } : {}),
    rejectedCandidateIds:
      choice.action === "create"
        ? suggestion.candidates.map((candidate) => candidate.transactionId)
        : [],
    ...(booking && { booking }),
  };
}

/** Whether the application is exactly the recommendation (Correct), not a correction (Wrong). */
function isRecommendedAsIs(
  suggestion: StatementSuggestionOut,
  application: StatementTransactionApplication,
): boolean {
  if (application.action !== suggestion.recommended) return false;
  if (
    application.kindOverride ||
    application.fields.length ||
    application.booking
  )
    return false;
  if (application.action === "attach")
    return (
      !application.transactionId ||
      application.transactionId === suggestion.candidates[0]?.transactionId
    );
  return true;
}

/** One review item applying the member's statement choice. */
export function statementApplyItem(
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
export function statementDismissItem(
  suggestion: StatementSuggestionOut,
): ReviewItem {
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

const base = (row: SuggestionListRow) => ({
  assessmentId: row.assessmentId,
  operationId: crypto.randomUUID(),
  correction: { present: false as const },
  ...(row.fingerprint ? { expectedFingerprint: row.fingerprint } : {}),
  reason: null,
  evidence: null,
});

/** Accept the row as suggested; rows requiring a separate choice offer another action. */
export function acceptItem(
  row: SuggestionListRow,
  statementChoice?: StatementChoice,
): ReviewItem | null {
  if (!offers(row, "accept")) return null;
  if (row.family === "statement_transaction")
    return statementApplyItem(row.evidence, statementChoice);
  if (row.family === "transfer_pair")
    return {
      ...base(row),
      verdict: "correct",
      intent: "apply",
      application: { kind: "transfer_pair" },
    };
  return {
    ...base(row),
    verdict: "correct",
    intent: "apply",
    application: row.review?.application,
  };
}

/** Wrong: the suggestion was mistaken; it applies nothing. */
export function wrongItem(row: SuggestionListRow): ReviewItem | null {
  if (!offers(row, "reject")) return null;
  return { ...base(row), verdict: "wrong", intent: "history" };
}

/** Dismiss: settle without applying; this pair of legs stays suppressed on every later pass. */
function transferPairDismissItem(
  row: Extract<SuggestionListRow, { family: "transfer_pair" }>,
): ReviewItem {
  return {
    ...base(row),
    verdict: "dismissed",
    intent: "history",
    suppression: {
      scope: "transfer_pair",
      candidateKey: row.evidence.key,
      fingerprint: row.fingerprint,
    },
  };
}

/** Dismiss without judging; a statement charge or transfer pair stays suppressed after. */
export function dismissItem(row: SuggestionListRow): ReviewItem {
  if (row.family === "statement_transaction")
    return statementDismissItem(row.evidence);
  if (row.family === "transfer_pair") return transferPairDismissItem(row);
  return { ...base(row), verdict: "dismissed", intent: "history" };
}

/**
 * Dismiss and never suggest it again, or null when the family has no lasting
 * suppression for this row. A statement or transfer-pair Dismiss already
 * suppresses its charge or pair.
 */
export function neverSuggestItem(row: SuggestionListRow): ReviewItem | null {
  if (row.review?.suppression && offers(row, "never_suggest"))
    return {
      ...base(row),
      verdict: "dismissed",
      intent: "history",
      suppression: row.review.suppression,
    };
  if (row.family === "statement_transaction")
    return statementDismissItem(row.evidence);
  if (row.family === "transfer_pair") return transferPairDismissItem(row);
  if (row.family !== "recommendation" || !offers(row, "never_suggest"))
    return null;
  if ("kind" in row.evidence) return null;
  const suppression = row.evidence.review.suppression;
  if (!suppression) return null;
  return {
    ...base(row),
    verdict: "dismissed",
    intent: "history",
    suppression,
  };
}
