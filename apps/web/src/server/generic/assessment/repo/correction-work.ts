import {
  assessmentChildHandle,
  assessmentSubjects,
} from "@cubby/schemas/assessment";
import type { retainedCorrectionEnrollmentFamily } from "@cubby/schemas/suggestion-correction";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, runAfterCommit } from "~/server/db/helpers";
import { assessment, feedback } from "~/server/db/schema";
import {
  fieldCorrectionKey,
  readConfirmedCorrection,
} from "~/server/generic/assessment/repo/correction-sources";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

export const correctionWorkInput = z.object({
  sourceFeedbackId: assessmentChildHandle.nullable(),
  targetAssessmentId: assessmentChildHandle.nullable().default(null),
  /** One publication commit's served targets, checked together. */
  targetAssessmentIds: z.array(assessmentChildHandle).default([]),
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
    // One Job per publication commit: live field suggestions publish a record's
    // fields together, and per-assessment Jobs were ~1k/h of mostly no-ops.
    const targets = rows
      .filter(correctionEligiblePublication)
      .map((row) => row.id);
    if (targets.length)
      await enqueueCorrectionIntent(db, {
        key: `assessment-correction-publication:${targets[0]}`,
        sourceFeedbackId: null,
        targetAssessmentId: null,
        targetAssessmentIds: targets,
      });
  }
}

export async function enqueueCorrectionWork(
  db: Database,
  sourceFeedbackId: string,
  targetAssessmentId: string | null,
) {
  await enqueueCorrectionIntent(db, {
    key: `assessment-correction:${sourceFeedbackId}:${targetAssessmentId ?? "history"}`,
    sourceFeedbackId,
    targetAssessmentId,
  });
}

/** A distinct fixed revision preserves completed pre-adapter history and receipts. */
export async function enrollRetainedCorrection(
  db: Database,
  sourceFeedbackId: string,
  family: z.infer<typeof retainedCorrectionEnrollmentFamily>,
) {
  const revision = {
    field: "field-identity-v2",
    image_description: "image-description-v1",
  }[family];
  await enqueueCorrectionIntent(db, {
    key: `assessment-correction-history:${revision}:${sourceFeedbackId}`,
    sourceFeedbackId,
    targetAssessmentId: null,
  });
}

async function enqueueCorrectionIntent(
  db: Database,
  input: {
    key: string;
    sourceFeedbackId: string | null;
    targetAssessmentId: string | null;
    targetAssessmentIds?: readonly string[];
  },
) {
  await enqueueJob(db, {
    key: input.key,
    kind: "assessment.correction",
    input: {
      sourceFeedbackId: input.sourceFeedbackId,
      targetAssessmentId: input.targetAssessmentId,
      ...(input.targetAssessmentIds?.length
        ? { targetAssessmentIds: [...input.targetAssessmentIds] }
        : {}),
    },
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
function correctionEligiblePublication(
  prediction: typeof assessment.$inferSelect,
) {
  if (!prediction.served) return false;
  if (prediction.family === "field")
    return Boolean(fieldCorrectionKey(prediction.evidence));
  if (prediction.family === "image_description") {
    const subject = assessmentSubjects.image_description.parse(
      prediction.subject,
    );
    return Boolean(
      subject.contentHash && prediction.fingerprint === subject.contentHash,
    );
  }
  return false;
}
