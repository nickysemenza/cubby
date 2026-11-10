import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

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

const stateDataObject = z.record(z.string(), z.json());
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
        data: suggestionTable.data,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, prediction.id))
      .for("update")
      .limit(1);
    const plan = planReviewHistory(input, prediction.family, state);
    if (plan.kind === "suppression") {
      await transitionSuggestionState(transactionDb, plan.id, {
        suppression: plan.suppression,
        status: "resolved",
      });
      return "resolved";
    }
    if (plan.kind === "transition") {
      const { id, reviewKey, nextStatus } = plan;
      await transitionSuggestionStates(
        transactionDb,
        or(
          eq(suggestionTable.id, id),
          reviewKey
            ? and(
                eq(suggestionTable.family, "field"),
                eq(suggestionTable.status, "pending"),
                sql`${suggestionTable.data}->>'reviewKey' = ${reviewKey}`,
              )
            : undefined,
        ),
        (row) => ({
          status: nextStatus,
          ...(reviewKey && {
            data: {
              ...stateDataObject.parse(row.data ?? {}),
              governingFeedbackId: event.id,
            },
          }),
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
