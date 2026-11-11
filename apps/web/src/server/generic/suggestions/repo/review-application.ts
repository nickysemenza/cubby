import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import {
  suggestionProjectionTargets,
  suggestionReviewOut,
} from "@cubby/schemas/suggestion";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { advisoryXactLock } from "~/server/db/advisory-lock";
import {
  getDb,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import {
  recordFeedback,
  type FeedbackEvent,
} from "~/server/generic/suggestions/repo/suggestion";
import { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { acknowledgeSavedField } from "~/server/generic/suggestions/repo/suggestion-field-receipt";
import type { ReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  suggestionStateColumns,
  suggestionRecordId,
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
      if (input.application?.kind === "saved_field") {
        ({ event } = await writeReview(transactionDb));
        await acknowledgeSavedField(transactionDb, context, prediction, {
          recordId: input.application.recordId,
          operationId: input.operationId,
          correction: input.correction,
          commandFeedback: event,
        });
      } else {
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
        if (
          input.expectedFingerprint !== undefined &&
          input.expectedFingerprint !==
            ("currentFingerprint" in family && family.currentFingerprint
              ? await family.currentFingerprint(transactionDb, applicableState)
              : applicableState.fingerprint)
        )
          throw new Error("Suggestion evidence fingerprint changed");
        (family.target ?? suggestionProjectionTargets[name]).parse(
          applicableState,
        );
        applicationResult =
          (await family.apply(
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
      }
      let fieldApplicationReceipt: z.infer<
        typeof suggestionAcceptanceReceipt
      > | null = null;
      if (
        prediction.family === "field" &&
        authority === "member" &&
        input.correction.present
      ) {
        const [field] = await getDb(transactionDb)
          .select(suggestionStateColumns)
          .from(suggestionTable)
          .where(eq(suggestionTable.id, prediction.id))
          .limit(1);
        if (!field)
          throw new Error("Corrected field application has no saved lineage");
        fieldApplicationReceipt = {
          ...suggestionAcceptanceReceipt.parse(field.acceptanceReceipt),
          appliedInputFingerprint: await fieldInputFingerprint(
            transactionDb,
            field.entity,
            suggestionRecordId(field),
            field.field,
          ),
        };
      }
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
