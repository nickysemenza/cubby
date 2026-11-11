import { type AutomaticRuleKey } from "@cubby/schemas/automatic-rule";
import {
  suggestionReviewInput,
  suggestionReviewBatchInput,
  suggestionSubjects,
  suggestionReviewOut,
} from "@cubby/schemas/suggestion";
import { getErrorMessage } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withSnapshotWriteDatabase } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import { settleMailDecisionReview } from "~/server/domains/purchase-import/repo/mail-decision-review";
import { statementSuggestionSourceHeld } from "~/server/domains/transaction-import/repo/source-observation-state";
import type { StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-input";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { recordFeedbackWithInsertion } from "~/server/generic/suggestions/repo/suggestion";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import type { ApplicationTerms } from "~/server/generic/suggestions/repo/suggestion-presentation";
import { isReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";

import { executeReviewApplication } from "./review-application";
import { settleReviewHistory } from "./review-history";
import { loadReviewPrediction } from "./review-load";
import {
  assertReviewAction,
  assertApplicationFamily,
  planReviewInput,
  type Prediction,
} from "./review-plan";

export type Review = z.infer<typeof suggestionReviewInput>;

/**
 * Internal only, set by `applyAutomaticRules` with the system actor: no
 * public schema carries it. It records `automatic` Feedback naming the rule.
 */
export type AutomaticReview = {
  authority: "automatic";
  rule: { key: AutomaticRuleKey; revision: string; stamp: string };
  statementScope?: StatementSuggestionScope;
};
export const automaticReviewInput = suggestionReviewInput.extend({
  operationId: z.string().regex(/^automatic:/),
});
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
    automatic: AutomaticReview | null,
  ) => Promise<z.infer<typeof suggestionReviewOut>["applicationResult"] | void>;
  /** Automatic reviews applied together under {@link reviewAutomaticPage}. */
  applyBatch?: AutomaticBatchHandler;
};

export type AutomaticBatchEntry = {
  state: SuggestionStateRow;
  prediction: Prediction;
  input: Review;
};

type AutomaticBatchHandler = {
  /**
   * Advisory identities {@link Handler.lockForApply} would take for these
   * predictions. The page takes them after its review locks and before any
   * Suggestion row lock.
   */
  lockKeys: (predictions: readonly Prediction[]) => string[];
  /**
   * Apply every entry it can, in order, under the page's locks. A `fallback`
   * entry has written nothing and keeps the single-review path; a throw rolls
   * back every entry. The handler owns the applied state transition, as
   * `apply` does.
   */
  apply: (
    db: Database,
    context: EntityKernelContext,
    entries: readonly AutomaticBatchEntry[],
    automatic: Omit<AutomaticReview, "rule">,
  ) => Promise<readonly ("applied" | "fallback")[]>;
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
  automatic?: AutomaticReview,
  emailScope?: EmailEvidenceWriteScope,
) {
  if (!automatic)
    return settleReview(
      db,
      context,
      suggestionReviewInput.parse(raw),
      null,
      emailScope,
    );
  const input = automaticReviewInput.parse(raw);
  if (
    !input.suggestionId ||
    input.verdict !== "correct" ||
    input.intent !== "apply" ||
    input.correction.present ||
    input.suppression
  )
    throw new Error("An Automatic rule only accepts an Suggestion as is");
  const suggestionId = input.suggestionId;
  const { assertAutomaticRuleOn } =
    await import("~/server/generic/suggestions/repo/automatic-application");
  return withSnapshotWriteDatabase(
    db,
    async (transactionDb) => {
      await (
        await import("~/server/workflows/runs/execution")
      ).assertWorkflowEffect(transactionDb);
      assertAutomaticRuleOn(automatic.rule.key, automatic.rule.stamp);
      if (automatic.statementScope) {
        const { statementLabelTargetsInScope } =
          await import("~/server/domains/transaction-import/repo/statement-suggestions");
        // This serializable write boundary must enforce the original selection
        // even when regeneration published valid evidence for another account.
        if (
          !(
            await statementLabelTargetsInScope(
              transactionDb,
              automatic.statementScope,
              [suggestionId],
            )
          ).has(suggestionId)
        )
          throw new Error(
            "Statement charge is outside the automatic application's scope",
          );
      }
      return settleReview(
        transactionDb,
        { ...context, db: transactionDb },
        input,
        automatic,
        emailScope,
      );
    },
    { isolationLevel: "serializable" },
  );
}

async function settleReview(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  automatic: AutomaticReview | null,
  emailScope?: EmailEvidenceWriteScope,
) {
  const authority = automatic ? "automatic" : "member";
  const loaded = await loadReviewPrediction(db, input);
  if (loaded.kind === "mail") {
    if (automatic)
      throw new Error(
        `${loaded.mail.family} Suggestions have no Automatic rule; review them`,
      );
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
  assertReviewAction(name, input.verdict, automatic);
  if (
    prediction.subject.kind === "statement_transaction" &&
    input.suppression
  ) {
    const sourceState = await getDb(db).execute<{ held: boolean }>(
      sql`SELECT ${statementSuggestionSourceHeld("s")} AS held FROM "Suggestion" s WHERE s.id=${prediction.id}::uuid`,
      "objects",
    );
    if (sourceState[0]?.held) input = { ...input, suppression: null };
  }

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
        ...(automatic && { rule: automatic.rule }),
      },
    });
  if (input.intent === "apply") {
    return executeReviewApplication(
      db,
      context,
      input,
      automatic,
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
