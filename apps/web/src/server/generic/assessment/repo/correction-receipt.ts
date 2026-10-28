import {
  assessmentChildHandle,
  feedbackAuthority,
  feedbackEvent,
} from "@cubby/schemas/assessment";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  suggestionCorrectionOutcome,
  correctionAuthorityReceiptKinds,
} from "@cubby/schemas/suggestion-correction";
import { inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { feedback } from "~/server/db/retained-tables";

type CorrectionReceipt =
  | { kind: "valid"; receipt: typeof feedback.$inferSelect }
  | { kind: "invalid" };

/** One durable outcome per root correction and target; automatic outcomes never become roots. */
export const correctionOperationId = (
  sourceFeedbackId: string,
  targetAssessmentId: string,
) => `correction:${sourceFeedbackId}:${targetAssessmentId}`;

// Keep indexed UUID columns intact. Only canonical stored handles matched the
// former id::text comparison; malformed historical metadata must remain unmatched.
const correctionFeedbackId = (
  key: "sourceFeedbackId" | "sourceApplicationFeedbackId",
) =>
  sql`substring(correction_outcome.metadata->>${key} FROM '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid`;

/** Historical attempts are visible only with their automatic receipt and bound member application. */
export function correctionOutcomeExists(assessmentId: SQL, receiptId?: SQL) {
  return sql`EXISTS (
    SELECT 1 FROM "Feedback" correction_outcome
    JOIN "Feedback" correction_root ON correction_root.id = ${correctionFeedbackId("sourceFeedbackId")}
    JOIN "Feedback" correction_application ON correction_application.id = ${correctionFeedbackId("sourceApplicationFeedbackId")}
    WHERE correction_outcome."assessmentId" = ${assessmentId}
      ${receiptId ? sql`AND correction_outcome.id = ${receiptId}` : sql``}
      AND correction_outcome.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND}
      AND correction_outcome.authority = ${feedbackAuthority.enum.automatic}
      AND correction_outcome."actorUserId" = ${SYSTEM_USER_ID}
      AND correction_outcome.intent = ${feedbackEvent.shape.intent.unwrap().enum.history}
      AND correction_outcome.correction->>${"present"} = ${String(false)}
      AND correction_outcome.suppression IS NULL
      AND correction_outcome."operationId" = 'correction:' || correction_root.id::text || ':' || correction_outcome."assessmentId"::text
      AND correction_outcome.receipt->>'status' IN (${sql.join(
        suggestionCorrectionOutcome.options.map(
          (option) => sql`${option.shape.status.value}`,
        ),
        sql`, `,
      )})
      AND correction_root.authority = ${feedbackAuthority.enum.member} AND correction_root.intent = ${feedbackEvent.shape.intent.unwrap().enum.apply}
      AND correction_root.correction->>${"present"} = ${String(true)}
      AND correction_root."actorUserId" IS NOT NULL
      AND correction_outcome.metadata->>'sourceActorUserId' = correction_root."actorUserId"
      AND correction_outcome.metadata->'correctedValue' = correction_root.correction->'value'
      AND correction_application."assessmentId" = correction_root."assessmentId"
      AND correction_application.metadata->>${"kind"} IN (${sql.join(
        correctionAuthorityReceiptKinds.options.map((kind) => sql`${kind}`),
        sql`, `,
      )})
      AND correction_application.metadata->>'commandFeedbackId' = correction_root.id::text
      AND correction_application.authority = correction_root.authority
      AND correction_application.intent = ${feedbackEvent.shape.intent.unwrap().enum.apply}
      AND correction_application."actorUserId" = correction_root."actorUserId"
      AND correction_application.suppression IS NULL AND correction_application.receipt IS NOT NULL
  )`;
}

/** Batch readers and replay use the same automatic-authority checks without scheduling work. */
async function readCorrectionReceipts(
  db: RepositoryQueryInput,
  targets: readonly { sourceFeedbackId: string; targetAssessmentId: string }[],
) {
  const expected = new Map(
    targets.map((target) => [
      correctionOperationId(target.sourceFeedbackId, target.targetAssessmentId),
      target,
    ]),
  );
  const receipts = new Map<string, CorrectionReceipt>();
  if (!expected.size) return receipts;
  const rows = await getDb(db)
    .select()
    .from(feedback)
    .where(inArray(feedback.operationId, [...expected.keys()]));
  return indexCorrectionReceipts(targets, rows);
}

/** Joined readers use exactly the replay reader's validation and invalid-duplicate precedence. */
export function indexCorrectionReceipts(
  targets: readonly { sourceFeedbackId: string; targetAssessmentId: string }[],
  rows: readonly (typeof feedback.$inferSelect)[],
): Map<string, CorrectionReceipt> {
  const expected = new Map(
    targets.map((target) => [
      correctionOperationId(target.sourceFeedbackId, target.targetAssessmentId),
      target,
    ]),
  );
  const receipts = new Map<string, CorrectionReceipt>();
  for (const row of rows) {
    const target = expected.get(row.operationId);
    const metadata = z
      .object({
        kind: z.literal(CORRECTION_OUTCOME_RECEIPT_KIND),
        sourceFeedbackId: assessmentChildHandle,
      })
      .safeParse(row.metadata);
    if (
      !target ||
      row.assessmentId !== target.targetAssessmentId ||
      !metadata.success ||
      metadata.data.sourceFeedbackId !== target.sourceFeedbackId ||
      row.authority !== "automatic" ||
      row.actorUserId !== SYSTEM_USER_ID ||
      row.intent !== "history" ||
      row.correction.present ||
      row.suppression ||
      !suggestionCorrectionOutcome.safeParse(row.receipt).success
    ) {
      receipts.set(row.operationId, { kind: "invalid" });
      continue;
    }
    if (receipts.get(row.operationId)?.kind !== "invalid")
      receipts.set(row.operationId, { kind: "valid", receipt: row });
  }
  return receipts;
}

export async function correctionAlreadyRecorded(
  db: Database,
  sourceFeedbackId: string,
  targetAssessmentId: string,
) {
  const receipts = await readCorrectionReceipts(db, [
    { sourceFeedbackId, targetAssessmentId },
  ]);
  const outcome = receipts.get(
    correctionOperationId(sourceFeedbackId, targetAssessmentId),
  );
  if (outcome?.kind === "invalid")
    throw new Error(
      "Invalid correction propagation receipt for this source and target",
    );
  return outcome?.receipt ?? null;
}
