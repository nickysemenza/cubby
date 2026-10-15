import { assessmentReviewReference } from "@cubby/schemas/assessment";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { assessment } from "~/server/db/schema";
import { publishAssessment } from "~/server/repo/assessment";
import { assessmentCandidateKey } from "~/server/repo/assessment-state";
import { getDb } from "~/server/repo/database-helpers";
import { canonicalJson } from "~/server/repo/entity-source";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/** Preferences preserve the exact declared candidate key, independently of grades. */
export async function assessRecommendation(
  db: Database,
  sourceId: string,
  scope: string,
  keys: readonly string[],
  evidence: unknown,
) {
  const recordId = await resolveOrThrow(db, "product", sourceId);
  const candidateKey = await assessmentCandidateKey(scope, keys);
  const snapshot = z.json().parse(evidence);
  const fingerprint = await sha256Hex(canonicalJson(snapshot));
  const publicationKey = `recommendation:${recordId}:${scope}:${candidateKey}:${fingerprint}`;
  const [existing] = await getDb(db)
    .select({ id: assessment.id })
    .from(assessment)
    .where(eq(assessment.publicationKey, publicationKey))
    .limit(1);
  const prediction =
    existing ??
    (await publishAssessment(db, {
      publicationKey,
      family: "recommendation",
      subject: {
        kind: "recommendation",
        entity: "product",
        recordId,
        scope,
        candidateKey,
      },
      judgment: { candidateKey },
      producer: null,
      fingerprint,
      evidence: snapshot,
    }));
  return assessmentReviewReference.parse({
    assessmentId: prediction.id,
    suppression: { scope, candidateKey, fingerprint: null },
  });
}
