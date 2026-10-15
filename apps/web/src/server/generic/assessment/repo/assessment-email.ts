import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, emailClassificationObservation } from "~/server/db/schema";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";

/** Observations retain retrieval/model lineage; Assessments own the review identity. */
export async function ensureEmailAssessment(
  db: Database,
  predictionId: string,
) {
  const [existing] = await getDb(db)
    .select()
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
    producer:
      row.model || row.stage === "rule"
        ? {
            kind: row.stage === "rule" ? "rule" : "model",
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
