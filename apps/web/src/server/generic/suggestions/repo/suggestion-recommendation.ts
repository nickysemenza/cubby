import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  suggestionReviewReference,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  publishSuggestion,
  type SuggestionFamily,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import { suggestionCandidateKey } from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson } from "~/server/lib/canonical-json";

/** One recommendation slot: a source record's candidate within a scope. */
export const recommendationSlot = (subject: {
  entity: string;
  recordId: string;
  scope: string;
  candidateKey: string;
}) => ({
  lock: `recommendation:${subject.entity}:${subject.recordId}:${subject.scope}:${subject.candidateKey}`,
  fields: {
    entity: subject.entity,
    recordId: subject.recordId,
    "subject.scope": subject.scope,
    "subject.candidateKey": subject.candidateKey,
  },
});

type Preference = {
  entity: ShortcodeEntity;
  recordId: string;
  scope: string;
  candidateKey: string;
  fingerprint: string;
  snapshot: z.infer<ReturnType<typeof z.json>>;
};

/**
 * Declared preferences. A reference names its exact evidence, so publication
 * keeps every earlier row and ignores dismissals: the reader applies them.
 */
const preferenceSuggestions: SuggestionFamily<Preference> = {
  family: "recommendation",
  slot: recommendationSlot,
  fingerprint: (preference) => preference.fingerprint,
  evidenceFingerprint: (preference) => preference.fingerprint,
  suppresses: () => false,
  onUnchanged: "none",
  replaced: "keep",
  publication: (preference) => ({
    input: {
      publicationKey: `recommendation:${preference.recordId}:${preference.scope}:${preference.candidateKey}:${preference.fingerprint}`,
      family: "recommendation",
      subject: {
        kind: "recommendation",
        entity: preference.entity,
        recordId: preference.recordId,
        scope: preference.scope,
        candidateKey: preference.candidateKey,
      },
      judgment: { candidateKey: preference.candidateKey },
      producer: null,
      fingerprint: preference.fingerprint,
      evidence: preference.snapshot,
    },
  }),
  labelBacklog: sql`false`,
};

/** Declared, not inferred: rows carry no producer. */
const preferenceProducer: SuggestionProducer = {
  kind: "rule",
  model: null,
  revision: null,
  runId: null,
  evaluationId: null,
};

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
  const outcome = await publishSuggestion(
    db,
    preferenceSuggestions,
    { entity, recordId, scope, candidateKey, fingerprint, snapshot },
    preferenceProducer,
  );
  const suggestionId =
    outcome.outcome === "published"
      ? outcome.suggestionId
      : outcome.outcome === "unchanged"
        ? outcome.rows[0]?.id
        : undefined;
  if (!suggestionId) throw new Error("Recommendation publication left no row");
  return suggestionReviewReference.parse({
    suggestionId,
    suppression: { scope, candidateKey, fingerprint: null },
  });
}
