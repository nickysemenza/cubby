import { suggestionReviewReference } from "@cubby/schemas/suggestion";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { publishSuggestion } from "~/server/generic/suggestions/repo/suggestion";
import { suggestionCandidateKey } from "~/server/generic/suggestions/repo/suggestion-state";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson } from "~/server/lib/canonical-json";

/** Preferences preserve the exact declared candidate key, independently of grades. */
export async function assessRecommendation(
  db: Database,
  sourceId: string,
  scope: string,
  keys: readonly string[],
  evidence: unknown,
  entity: ShortcodeEntity = "product",
) {
  const recordId = await resolveOrThrow(db, entity, sourceId);
  const candidateKey = await suggestionCandidateKey(scope, keys);
  const snapshot = z.json().parse(evidence);
  const fingerprint = await sha256Hex(canonicalJson(snapshot));
  const publicationKey = `recommendation:${recordId}:${scope}:${candidateKey}:${fingerprint}`;
  const [existing] = await getDb(db)
    .select({ id: suggestionTable.id })
    .from(suggestionTable)
    .where(eq(suggestionTable.publicationKey, publicationKey))
    .limit(1);
  const prediction =
    existing ??
    (await publishSuggestion(db, {
      publicationKey,
      family: "recommendation",
      subject: {
        kind: "recommendation",
        entity,
        recordId,
        scope,
        candidateKey,
      },
      judgment: { candidateKey },
      producer: null,
      fingerprint,
      evidence: snapshot,
    }));
  return suggestionReviewReference.parse({
    suggestionId: prediction.id,
    suppression: { scope, candidateKey, fingerprint: null },
  });
}
