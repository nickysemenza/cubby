import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import type { FeedbackEvent } from "~/server/generic/suggestions/repo/suggestion";
import {
  transitionSuggestionState,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";

import type { Review } from "./review";
import { planReviewHistory, type Prediction } from "./review-plan";

export async function settleReviewHistory(
  db: Database,
  input: Review,
  emailScope: EmailEvidenceWriteScope | undefined,
  prediction: Prediction,
  event: FeedbackEvent,
) {
  const writeHistory = async (transactionDb: Database) => {
    const [state] = await getDb(transactionDb)
      .select({
        id: suggestionTable.id,
        active: suggestionTable.active,
        status: suggestionTable.status,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, prediction.id))
      .for("update")
      .limit(1);
    const plan = planReviewHistory(input, state);
    if (plan.kind === "suppression") {
      await transitionSuggestionState(transactionDb, plan.id, {
        suppression: plan.suppression,
        status: "resolved",
      });
      return "resolved";
    }
    if (plan.kind === "transition") {
      const { id, nextStatus } = plan;
      await transitionSuggestionStates(
        transactionDb,
        eq(suggestionTable.id, id),
        () => ({
          status: nextStatus,
          ...(input.correction.present && {
            correctValue: input.correction.value,
          }),
        }),
      );
      return nextStatus;
    }
    return plan.status;
  };
  const status = await withEmailReviewBoundary(
    db,
    prediction,
    (scopedDb) => withTransactionDatabase(scopedDb, writeHistory),
    emailScope,
  );
  return {
    suggestionId: prediction.id,
    feedbackId: event.id,
    status,
    applied: false,
  };
}
