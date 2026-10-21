import { eq } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  assessment,
  emailClassificationObservation,
} from "~/server/db/retained-tables";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";

export const EMAIL_OBSERVATION_RECEIPT = "email_classification_observation";
export const EMAIL_APPLICATION_RECEIPT = "email_classification_application";

/** Called inside the transaction that publishes the effective Email routing. */
export async function recordEmailClassificationApplication(
  db: Database,
  predictionId: string,
) {
  const assessment = await ensureEmailAssessment(db, predictionId);
  await recordFeedback(db, {
    assessmentId: assessment.id,
    operationId: "classification-applied",
    authority: "automatic",
    actorUserId: null,
    verdict: "ungraded",
    intent: "history",
    correction: { present: false },
    metadata: { kind: EMAIL_APPLICATION_RECEIPT, predictionId, applied: true },
  });
}

/** Observations retain retrieval/model lineage; Assessments own the review identity. */
export async function ensureEmailAssessment(
  db: Database,
  predictionId: string,
) {
  const [existing] = await getDb(db)
    .select({ id: assessment.id, judgment: assessment.judgment })
    .from(assessment)
    .where(eq(assessment.publicationKey, `email-observation:${predictionId}`))
    .limit(1);
  if (existing) return existing;
  const [row] = await getDb(db)
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.id, predictionId))
    .limit(1);
  if (!row) throw new Error("Frozen Email prediction not found");
  return publishAssessment(db, {
    publicationKey: `email-observation:${row.id}`,
    family: "email_relevance",
    subject: {
      kind: "email_relevance",
      entity: "email",
      recordId: row.emailId,
      checksum: row.checksum,
      observationId: row.id,
    },
    judgment: { classification: row.classification, stage: row.stage },
    // A resolution carries a revision only when a rule applied it for a Run.
    producer:
      row.model ||
      row.stage === "rule" ||
      (row.stage === "resolution" && row.promptVersion)
        ? {
            kind: row.stage === "rule" || !row.model ? "rule" : "model",
            model: row.model,
            revision: row.promptVersion,
            runId: row.runId,
            evaluationId: row.evaluationId,
          }
        : null,
    fingerprint: row.checksum,
    evidence: { checksum: row.checksum, provenance: row.provenance },
  });
}
export const emailGradeMetadata = z.object({
  kind: z.literal("email_accuracy"),
  evaluationId: z.uuid(),
  predictionId: z.uuid(),
  grade: z.enum(["related", "unrelated", "uncertain", "unavailable"]),
  reviewedChecksum: z.string().nullable(),
});
