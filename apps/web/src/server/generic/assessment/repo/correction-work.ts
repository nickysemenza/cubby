import { assessmentChildHandle } from "@cubby/schemas/assessment";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  suggestionCorrectionOutcome,
} from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, runAfterCommit } from "~/server/db/helpers";
import { assessment, feedback } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  fieldCorrectionKey,
  readConfirmedCorrection,
} from "~/server/generic/assessment/repo/correction-sources";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

export const correctionWorkInput = z.object({
  sourceFeedbackId: assessmentChildHandle.nullable(),
  targetAssessmentId: assessmentChildHandle.nullable().default(null),
});

export async function recordCorrectionWork(
  db: Database,
  change:
    | { kind: "publications"; ids: readonly string[] }
    | { kind: "application"; receiptId: string },
) {
  if (change.kind === "application") {
    const [receipt] = await getDb(db)
      .select()
      .from(feedback)
      .where(eq(feedback.id, change.receiptId))
      .limit(1);
    if (receipt) await enqueueConfirmedCorrection(db, receipt);
  } else if (change.ids.length) {
    const rows = await getDb(db)
      .select()
      .from(assessment)
      .where(inArray(assessment.id, [...change.ids]));
    for (const row of rows) await enqueueCorrectionsForPublication(db, row);
  }
}

export async function enqueueCorrectionWork(
  db: Database,
  sourceFeedbackId: string,
  targetAssessmentId: string | null,
) {
  await enqueueJob(db, {
    key: `assessment-correction:${sourceFeedbackId}:${targetAssessmentId ?? "history"}`,
    kind: "assessment.correction",
    input: { sourceFeedbackId, targetAssessmentId },
  });
  await runAfterCommit(db, async () => {
    const { wakeJobs } =
      await import("~/server/workflows/background-tasks/publish");
    await wakeJobs({ source: "assessment.correction" });
  });
}

/** Enroll only with a committed command-bound member application, never a grade. */
async function enqueueConfirmedCorrection(
  db: Database,
  receipt: typeof feedback.$inferSelect,
) {
  if (receipt.authority !== "member" || receipt.intent !== "apply") return;
  const metadata = z
    .object({
      kind: z.enum(["assessment_application", "saved_field"]),
      commandFeedbackId: assessmentChildHandle,
    })
    .safeParse(receipt.metadata);
  if (!metadata.success) return;
  const source = await readConfirmedCorrection(
    db,
    metadata.data.commandFeedbackId,
  );
  if (source) await enqueueCorrectionWork(db, source.feedbackId, null);
}

/** New immutable proposals revisit existing authority; reads never initiate repair. */
async function enqueueCorrectionsForPublication(
  db: Database,
  prediction: typeof assessment.$inferSelect,
) {
  if (!prediction.served || prediction.family !== "field") return;
  const key = fieldCorrectionKey(prediction.evidence);
  if (!key) return;
  await enqueueJob(db, {
    key: `assessment-correction-publication:${prediction.id}`,
    kind: "assessment.correction",
    input: { sourceFeedbackId: null, targetAssessmentId: prediction.id },
  });
  await runAfterCommit(db, async () => {
    const { wakeJobs } =
      await import("~/server/workflows/background-tasks/publish");
    await wakeJobs({ source: "assessment.correction" });
  });
}

export async function correctionAlreadyRecorded(
  db: Database,
  sourceFeedbackId: string,
  targetAssessmentId: string,
) {
  const [receipt] = await getDb(db)
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.assessmentId, targetAssessmentId),
        eq(
          feedback.operationId,
          correctionOperationId(sourceFeedbackId, targetAssessmentId),
        ),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  const metadata = z
    .object({
      kind: z.literal(CORRECTION_OUTCOME_RECEIPT_KIND),
      sourceFeedbackId: assessmentChildHandle,
    })
    .parse(receipt.metadata);
  if (
    metadata.sourceFeedbackId !== sourceFeedbackId ||
    receipt.authority !== "automatic" ||
    receipt.actorUserId !== systemActor().userId ||
    receipt.intent !== "history" ||
    receipt.correction.present ||
    receipt.suppression
  )
    throw new Error(
      "Invalid correction propagation receipt for this source and target",
    );
  suggestionCorrectionOutcome.parse(receipt.receipt);
  return receipt;
}

/** One durable outcome per root correction and target; propagated outcomes never become roots. */
export const correctionOperationId = (
  sourceFeedbackId: string,
  targetAssessmentId: string,
) => `correction:${sourceFeedbackId}:${targetAssessmentId}`;
