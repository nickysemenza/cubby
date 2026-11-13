import {
  suggestionProjectionTargets,
  suggestionReviewOut,
} from "@cubby/schemas/suggestion";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { advisoryLockKey, advisoryXactLock } from "~/server/db/advisory-lock";
import {
  getDb,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  recordFeedback,
  type FeedbackEvent,
} from "~/server/generic/suggestions/repo/suggestion";
import { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  changedTerms,
  reviewKey,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import type { ReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  suggestionStateColumns,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";

import type { Review, AutomaticReview } from "./review";
import {
  planApplicationReceipt,
  planApplicableState,
  type Prediction,
} from "./review-plan";

export function executeReviewApplication(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  automatic: AutomaticReview | null,
  emailScope: EmailEvidenceWriteScope | undefined,
  prediction: Prediction,
  name: ReviewFamily,
  family: (typeof suggestionFamilies)[ReviewFamily],
  writeReview: (db: Database) => Promise<{ event: FeedbackEvent }>,
) {
  const authority = automatic ? "automatic" : "member";
  const executeApplication = () => {
    const apply = async (transactionDb: Database) => {
      // The review and its application commit together: a refused or stale
      // application leaves no Feedback, so a retry may carry a fresh review.
      const outcome = (event: FeedbackEvent) =>
        ({
          suggestionId: prediction.id,
          feedbackId: event.id,
          status: "applied",
          applied: true,
        }) satisfies z.infer<typeof suggestionReviewOut>;
      // Serialize generic commands without taking projection locks ahead of the
      // domain's parent locks. Receipt and mutation commit in the same boundary.
      // The subject lock comes first: an apply supersedes the subject's other
      // live rows, so two of them applying at once would deadlock on each other.
      // The id lock is the key mail decision review shares. One statement
      // takes both, left to right.
      if (prediction.subject) {
        const subject = advisoryLockKey(
          "suggestion-review",
          `${prediction.family}:${JSON.stringify(prediction.subject)}`,
        );
        const own = advisoryLockKey("suggestion-review", prediction.id);
        await getDb(transactionDb).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${subject}, 0)), pg_advisory_xact_lock(hashtextextended(${own}, 0))`,
        );
      } else
        await advisoryXactLock(
          getDb(transactionDb),
          "suggestion-review",
          prediction.id,
        );
      const [owner] = await getDb(transactionDb)
        .select({ decisions: suggestionTable.decisions })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, prediction.id));
      const receipt = decisionForOperation(
        prediction.id,
        owner?.decisions ?? [],
        `command-application:${input.operationId}`,
      );
      if (receipt) {
        const { event } = await writeReview(transactionDb);
        return planApplicationReceipt(receipt, event, outcome(event));
      }
      let event: FeedbackEvent;
      let applicationResult: z.infer<
        typeof suggestionReviewOut
      >["applicationResult"];
      {
        if ("lockForApply" in family && family.lockForApply)
          await family.lockForApply(transactionDb, prediction);
        const query = getDb(transactionDb)
          .select(suggestionStateColumns)
          .from(suggestionTable)
          .where(eq(suggestionTable.id, prediction.id))
          .limit(1);
        // Two accepted reviews can race; serialize application on the Suggestion owner.
        const [state] =
          family.transactionBound !== false
            ? await query.for("update")
            : await query;
        const applicableState = planApplicableState(state, prediction.family);
        if (!input.expectedFingerprint)
          throw new Error(
            "An applying review needs expectedFingerprint; send the listed row's fingerprint",
          );
        const live =
          "applicationKey" in family && family.applicationKey
            ? await family.applicationKey(transactionDb, applicableState)
            : undefined;
        // A declared key of null means nothing current can apply; falling back
        // to the Suggestion id would let any caller that sends it through.
        const key =
          live === null
            ? null
            : reviewKey({
                suggestionId: applicableState.id,
                fingerprint: live ?? applicableState.fingerprint,
              });
        if (key === null || input.expectedFingerprint !== key) {
          const changed =
            "applicationTerms" in family && family.applicationTerms
              ? changedTerms(
                  await family.applicationTerms(transactionDb, applicableState),
                )
              : [];
          throw new Error(
            `Suggestion changed since review${changed.length ? `: ${changed.join(", ")}` : ""}; list it again and review the current version`,
          );
        }
        (family.target ?? suggestionProjectionTargets[name]).parse(
          applicableState,
        );
        applicationResult =
          (await family.apply!(
            transactionDb,
            { ...context, db: transactionDb },
            applicableState,
            input,
            automatic,
          )) ?? undefined;
        // Domain parent locks precede the Suggestion row lock Feedback takes.
        ({ event } = await writeReview(transactionDb));
        if (family.transactionBound === false)
          await transitionSuggestionStates(
            transactionDb,
            and(
              eq(suggestionTable.id, applicableState.id),
              eq(suggestionTable.active, true),
            ),
            { status: "applied" },
          );
        // The apply settled this subject; another live row for it is a
        // duplicate whose apply would write the same thing twice.
        await transitionSuggestionStates(
          transactionDb,
          and(
            eq(suggestionTable.family, prediction.family),
            "liveSubjectRows" in family && family.liveSubjectRows
              ? family.liveSubjectRows([prediction.subject])
              : sql`${suggestionTable.subject} = ${JSON.stringify(prediction.subject)}::jsonb`,
            ne(suggestionTable.id, applicableState.id),
            eq(suggestionTable.active, true),
            eq(suggestionTable.status, "pending"),
          ),
          { active: false, status: "superseded" },
        );
      }
      const fieldApplicationReceipt = await family.afterApply?.(
        transactionDb,
        prediction,
        input,
        authority,
      );
      const applied = {
        ...outcome(event),
        ...(applicationResult && { applicationResult }),
      };
      await recordFeedback(transactionDb, {
        suggestionId: prediction.id,
        operationId: `command-application:${input.operationId}`,
        verdict: "ungraded",
        intent: "apply",
        authority,
        actorUserId: context.actorContext.userId,
        receipt: applied,
        metadata: {
          kind: "assessment_application",
          commandFeedbackId: event.id,
          ...(fieldApplicationReceipt && { fieldApplicationReceipt }),
          ...(automatic && { rule: automatic.rule }),
        },
      });
      return applied;
    };
    return withEmailReviewBoundary(
      db,
      prediction,
      (scopedDb) =>
        "isolationLevel" in family && family.isolationLevel === "serializable"
          ? withSnapshotWriteDatabase(scopedDb, apply, {
              isolationLevel: "serializable",
            })
          : withTransactionDatabase(scopedDb, apply),
      emailScope,
    );
  };
  return executeApplication();
}
