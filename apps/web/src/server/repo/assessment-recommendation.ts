import { assessmentReviewReference } from "@cubby/schemas/assessment";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { Database } from "~/server/db";
import { publishAssessment } from "~/server/repo/assessment";
import { canonicalJson } from "~/server/repo/entity-source";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { suggestionCandidateKey } from "~/server/repo/suggestion-dismissal";

/** Preferences preserve the exact declared candidate key, independently of grades. */
export async function assessRecommendation(
  db: Database,
  sourceId: string,
  scope: string,
  keys: readonly string[],
  evidence: unknown,
) {
  const recordId = await resolveOrThrow(db, "product", sourceId);
  const candidateKey = await suggestionCandidateKey(scope, keys);
  const snapshot = z.json().parse(evidence);
  const fingerprint = await sha256Hex(canonicalJson(snapshot));
  const prediction = await publishAssessment(db, {
    publicationKey: `recommendation:${recordId}:${scope}:${candidateKey}:${fingerprint}`,
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
  });
  return assessmentReviewReference.parse({
    assessmentId: prediction.id,
    suppression: { scope, candidateKey, fingerprint: null },
  });
}
