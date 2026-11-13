import {resolveMailDecisionHandle} from "~/server/domains/purchase-import/repo/mail-decision-review";
import {
  suggestionReviewInput,
  suggestionReviewBatchInput,
  suggestionReviewOut,
} from "@cubby/schemas/suggestion";
import { getErrorMessage } from "@cubby/shared";
import { type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { settleMailDecisionReview } from "~/server/domains/purchase-import/repo/mail-decision-review";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";

import type { ApplicationTerms } from "~/server/generic/suggestions/repo/suggestion-presentation";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";

import { reviewGap } from "./gap-review";

import {
  assertReviewAction,
  assertApplicationFamily,
  planReviewInput,
} from "./review-plan";

export type Review = z.infer<typeof suggestionReviewInput>;

export type Handler = {
  subject?: z.ZodType;
  target?: z.ZodType;
  actions?: readonly Review["verdict"][];
  transactionBound?: boolean;
  /** Domain parent locks must precede the suggestion's projection row lock. */
  lockForApply?: (
    db: Database,
    prediction: Pick<
      typeof suggestionTable.$inferSelect,
      "subject" | "judgment"
    >,
  ) => Promise<void>;
  /**
   * The fingerprint a list publishes for this row when it is computed live
   * rather than stored; the review must name it. Defaults to the stored one.
   */
  applicationKey?: (
    db: Database,
    state: SuggestionStateRow,
  ) => Promise<string | null>;
  /**
   * What applying writes, as published and as it is now, by part name; a
   * refusal names each part that differs.
   */
  applicationTerms?: (
    db: Database,
    state: SuggestionStateRow,
  ) => Promise<ApplicationTerms>;
  apply: (
    db: Database,
    context: EntityKernelContext,
    state: SuggestionStateRow,
    input: Review,
  ) => Promise<z.infer<typeof suggestionReviewOut>["applicationResult"] | void>;

  /**
   * The family's live rows for these subjects on its own slot index. An apply
   * supersedes a duplicate through it; whole-subject equality has no index and
   * would read, and serializably lock, the family's entire live backlog.
   */
  liveSubjectRows?: (subjects: readonly unknown[]) => SQL;
};

/**
 * Draft and history verdicts settle on their own. An applying review commits
 * with its application, so a stale or refused application records nothing and
 * the same operation may retry with a corrected review.
 */
export async function reviewSuggestion(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof suggestionReviewInput>,
  emailScope?: EmailEvidenceWriteScope,
) {
  return settleReview(
    db,
    context,
    suggestionReviewInput.parse(raw),
    emailScope,
  );
}

async function settleReview(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  emailScope?: EmailEvidenceWriteScope,
) {
  const gap = await reviewGap(db, context, input);
  if (gap) return gap;
  if (!input.suggestionId) throw new Error("Review needs a current evidence gap");
  const mail=await resolveMailDecisionHandle(db,input.suggestionId);
  if (!mail) throw new Error("The reviewable evidence is not available");
  return settleMailDecisionReview(db,context,input,mail,emailScope);
}

export async function reviewSuggestionBatch(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof suggestionReviewBatchInput>,
) {
  const { items } = suggestionReviewBatchInput.parse(raw);
  const results = [];
  for (const item of items) {
    try {
      results.push({
        ...(await reviewSuggestion(db, context, item)),
        ok: true as const,
      });
    } catch (error) {
      results.push({
        suggestionId: item.suggestionId ?? null,
        ok: false as const,
        error: getErrorMessage(error),
      });
    }
  }
  return results;
}
