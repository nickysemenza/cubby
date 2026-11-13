import {
  suggestionReviewInput,
  suggestionReviewBatchInput,
  suggestionSubjects,
  suggestionReviewOut,
} from "@cubby/schemas/suggestion";
import { getErrorMessage } from "@cubby/shared";
import { type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import { settleMailDecisionReview } from "~/server/domains/purchase-import/repo/mail-decision-review";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { recordFeedbackWithInsertion } from "~/server/generic/suggestions/repo/suggestion";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import type { ApplicationTerms } from "~/server/generic/suggestions/repo/suggestion-presentation";
import { isReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";

import { reviewGap } from "./gap-review";
import { executeReviewApplication } from "./review-application";
import { settleReviewHistory } from "./review-history";
import { loadReviewPrediction } from "./review-load";
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
  /** Snapshot-dependent domain planning owns the outer retry boundary. */
  isolationLevel?: "serializable";
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
  const authority = "member" as const;
  const loaded = await loadReviewPrediction(db, input);
  if (loaded.kind === "mail") {
    assertApplicationFamily(loaded.mail.family, input.application);
    return settleMailDecisionReview(
      db,
      context,
      input,
      loaded.mail,
      emailScope,
    );
  }
  const prediction = loaded.prediction;
  if (!prediction) throw new Error("Suggestion not found");
  // Problems findings and grading rosters are resolved by their own paths.
  const name = prediction.family;
  if (!isReviewFamily(name))
    throw new Error(`${name} Suggestions are not reviewed as Suggestions`);
  const family = suggestionFamilies[name];
  (family.subject ?? suggestionSubjects[name]).parse(prediction.subject);
  assertReviewAction(name, input.verdict);

  input = planReviewInput(input, prediction);
  const writeReview = (transactionDb: Database) =>
    recordFeedbackWithInsertion(transactionDb, {
      ...input,
      suggestionId: prediction.id,
      authority,
      actorUserId: context.actorContext.userId,
      metadata: {
        kind: "assessment_review",
        application: input.application ?? null,
        expectedFingerprint: input.expectedFingerprint ?? null,
      },
    });
  if (input.intent === "apply") {
    return executeReviewApplication(
      db,
      context,
      input,
      emailScope,
      prediction,
      name,
      family,
      writeReview,
    );
  }
  const { event } = await withEmailReviewBoundary(
    db,
    prediction,
    writeReview,
    emailScope,
  );
  if (input.intent === "draft") {
    return {
      suggestionId: prediction.id,
      feedbackId: event.id,
      status: "draft",
      applied: false,
    };
  }
  return settleReviewHistory(db, input, emailScope, prediction, event);
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
