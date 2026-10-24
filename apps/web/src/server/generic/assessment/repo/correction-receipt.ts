import { assessmentChildHandle } from "@cubby/schemas/assessment";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  suggestionCorrectionOutcome,
} from "@cubby/schemas/suggestion-correction";
import { inArray } from "drizzle-orm";
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

/** Batch readers and replay use the same automatic-authority checks without scheduling work. */
export async function readCorrectionReceipts(
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
