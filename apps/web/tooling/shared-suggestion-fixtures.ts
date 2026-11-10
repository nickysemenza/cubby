import { z } from "zod";
import {
  fieldSuggestionPublication,
  publishSuggestions,
} from "~/server/generic/suggestions/repo/suggestion";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  emailClassificationObservation,
  emailReview,
  suggestionTable,
} from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { publishEmailLinkDecision } from "~/server/domains/email/repo/email-link-decision";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";

type EmailLinkDecision = Omit<
  Parameters<typeof publishEmailLinkDecision>[1],
  "proposedBy"
> & {
  proposedBy?: Parameters<typeof publishEmailLinkDecision>[1]["proposedBy"];
};

/** Retained Email reviews of one recorded metadata kind. */
export async function listEmailReviewsByKind(db: Database, kind: string) {
  return getDb(db)
    .select()
    .from(emailReview)
    .where(sql`${emailReview.metadata} @> ${JSON.stringify({ kind })}::jsonb`);
}

/** Seed a real shared Email link decision for integration-test setup. */
export async function seedEmailLinkDecision(
  db: Database,
  input: EmailLinkDecision,
) {
  const proposedBy = input.proposedBy ?? null;
  const authority =
    proposedBy === null || proposedBy === "member" ? "member" : "automatic";
  return publishEmailLinkDecision(db, { ...input, proposedBy }, authority);
}

/** A member's label on a retained prediction. */
export async function seedEmailClassificationFeedback(
  db: Database,
  input: {
    predictionId: string;
    classification: "related" | "unrelated" | "uncertain";
    reason: string | null;
    actorUserId: string | null;
    authority?: "member" | "automatic";
  },
) {
  const [prediction] = await getDb(db)
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.id, input.predictionId))
    .limit(1);
  if (!prediction) throw new Error("Frozen Email prediction not found");
  const authority = input.authority ?? "member";
  return appendEmailReview(db, {
    family: "email_relevance",
    subjectId: prediction.id,
    emailId: prediction.emailId,
    originalId: null,
    checksum: prediction.checksum,
    classification: input.classification,
    operationId: `email-classification-review:${input.predictionId}:${randomUUID()}`,
    verdict:
      input.classification === "uncertain"
        ? "uncertain"
        : input.classification === prediction.classification
          ? "correct"
          : "wrong",
    correction: { present: true, value: input.classification },
    reason: input.reason,
    intent: "apply",
    authority,
    actorUserId: input.actorUserId,
    subject: {
      kind: "email_relevance",
      entity: "email",
      recordId: prediction.emailId,
      checksum: prediction.checksum,
      observationId: prediction.id,
    },
    metadata: {
      kind: "email_classification_review",
      predictionId: input.predictionId,
    },
  });
}

export async function seedFieldSuggestion(
  db: Database,
  projection: Parameters<typeof fieldSuggestionPublication>[0],
  _served = true,
) {
  const data = z.record(z.string(), z.json()).parse(projection.data ?? {});
  if (!("connectionEvidence" in data) && !("liveInputFingerprint" in data))
    data.liveInputFingerprint = await fieldInputFingerprint(
      db,
      projection.entity,
      projection.recordId,
      projection.field,
    );
  const [row] = await publishSuggestions(db, [
    fieldSuggestionPublication({ ...projection, data }),
  ]);
  if (!row) throw new Error("Synthetic field publication returned no row");
  return row;
}

/**
 * Stamp a seeded field Suggestion with the current executable AI policy, as a
 * real evaluation would, so the automatic gate can apply it.
 */
export async function stampCurrentFieldProvenance(
  db: Database,
  suggestion: { id: string },
  entity: string,
  field: string,
) {
  await getDb(db)
    .update(suggestionTable)
    .set({
      provenance: {
        dependencies: dependencyStamps(
          await producingAiManifest(db),
          fieldDependencyKeys(entity, field),
        ),
        inputFingerprint: "synthetic",
        optionFingerprint: "synthetic",
        model: "typesafe/jev",
      },
    })
    .where(eq(suggestionTable.id, suggestion.id));
}
