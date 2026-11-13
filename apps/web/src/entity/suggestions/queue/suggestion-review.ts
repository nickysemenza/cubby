import type { suggestionReviewInput } from "@cubby/schemas/suggestion";
import type {
  SuggestionActionVerb,
  SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import type { z } from "zod";

export type ReviewItem = z.input<typeof suggestionReviewInput>;

/** The member's pick for one statement suggestion, before it becomes a review item. */

/** Whether the server offers `verb` on this row (owner-only verbs included). */
export const offers = (row: SuggestionListRow, verb: SuggestionActionVerb) =>
  row.actions.some((action) => action.verb === verb);

/**
 * The application the server applies for a choice. A create lists every
 * candidate as rejected: the server refuses a create while any possible
 * existing transaction is still live.
 */

/** Whether the application is exactly the recommendation (Correct), not a correction (Wrong). */

/** One review item applying the member's statement choice. */

/** Dismiss: settle without applying; the charge stays suppressed on every later pass. */

const base = (row: SuggestionListRow) => ({
  suggestionId: row.suggestionId,
  operationId: crypto.randomUUID(),
  correction: { present: false as const },
  expectedFingerprint: row.fingerprint,
  reason: null,
  evidence: null,
});

/** Accept the row as suggested; rows requiring a separate choice offer another action. */
export function acceptItem(row: SuggestionListRow): ReviewItem | null {
  if (!offers(row, "accept")) return null;

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
