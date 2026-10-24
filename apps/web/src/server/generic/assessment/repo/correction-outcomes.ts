import { assessmentChildHandle } from "@cubby/schemas/assessment";
import { automaticDecisionRow } from "@cubby/schemas/automatic-decision";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  suggestionCorrectionOutcome,
} from "@cubby/schemas/suggestion-correction";
import { and, desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { feedback } from "~/server/db/schema";
import { correctionOutcomeExists } from "~/server/generic/assessment/repo/correction-receipt";

/** Bounded to the page's Assessment ids; immutable receipts are the audit owner. */
export async function readCorrectionOutcomes(
  db: Database,
  assessmentIds: readonly string[],
) {
  const results = new Map<
    string,
    {
      outcome: z.infer<typeof suggestionCorrectionOutcome>;
      correctedValue: z.infer<ReturnType<typeof z.json>>;
      attempt: z.infer<typeof automaticDecisionRow.shape.correctionAttempt>;
    }
  >();
  if (!assessmentIds.length) return results;
  const rows = await getDb(db)
    .selectDistinctOn([feedback.assessmentId], {
      assessmentId: feedback.assessmentId,
      id: feedback.id,
      createdAt: feedback.createdAt,
      receipt: feedback.receipt,
      metadata: feedback.metadata,
    })
    .from(feedback)
    .where(
      and(
        inArray(feedback.assessmentId, [...assessmentIds]),
        correctionOutcomeExists(
          sql`${feedback.assessmentId}`,
          sql`${feedback.id}`,
        ),
        sql`${feedback.metadata}->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND}`,
      ),
    )
    .orderBy(
      feedback.assessmentId,
      desc(feedback.createdAt),
      desc(feedback.id),
    );
  for (const row of rows) {
    const metadata = z
      .object({
        correctedValue: z.json(),
        sourceFeedbackId: assessmentChildHandle,
        sourceApplicationFeedbackId: assessmentChildHandle,
      })
      .parse(row.metadata);
    const outcome = suggestionCorrectionOutcome.parse(row.receipt);
    results.set(row.assessmentId, {
      outcome,
      correctedValue: metadata.correctedValue,
      attempt: automaticDecisionRow.shape.correctionAttempt.parse({
        receiptId: row.id,
        sourceFeedbackId: metadata.sourceFeedbackId,
        sourceApplicationFeedbackId: metadata.sourceApplicationFeedbackId,
        createdAt: row.createdAt.toISOString(),
        outcome,
      }),
    });
  }
  return results;
}
