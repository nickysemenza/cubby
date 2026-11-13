import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  emailClassificationObservation,
  emailReview,
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

/** Seed a retained field Answer and the reconciler gap presented to a member. */
export async function seedFieldSuggestion(
  db: Database,
  projection: {
    entity: string;
    recordId: string;
    field: string;
    suggestedValue?: unknown;
    currentValue?: unknown;
    confidence?: number;
    model?: string;
    runId?: string | null;
    createdAt?: Date;
    kind?: string;
    status?: string;
    data?: unknown;
    runnerUpValue?: string | null;
    runnerUpConfidence?: number | null;
  },
  _served = true,
) {
  const { fieldAsk } = await import("~/server/ai/fields/ask");
  const { withAsk } = await import("~/server/kernel/api");
  const { ask, answer } = await import("~/server/db/kernel-schema");
  const { resolveOrThrow } =
    await import("~/server/generic/shortcode/repo/shortcode-resolver");
  const { fieldReviewPlan } = await import("~/server/ai/fields/repo/plan");
  const plan = fieldReviewPlan(projection.entity, projection.field);
  const stored = async (value: string) =>
    plan?.field.reference
      ? await resolveOrThrow(db, plan.field.reference, value)
      : value;
  const proposal =
    projection.suggestedValue == null
      ? null
      : {
          value: await stored(String(projection.suggestedValue)),
          label: null,
          confidence: projection.confidence ?? 0.8,
          runnerUp: projection.runnerUpValue
            ? {
                value: await stored(projection.runnerUpValue),
                label: null,
                confidence: projection.runnerUpConfidence ?? 0,
              }
            : null,
        };
  const input = {
    entity: projection.entity,
    recordId: projection.recordId,
    field: projection.field,
    row: { synthetic: randomUUID() },
    precedents: [],
  };
  await withAsk(
    db,
    {
      ...fieldAsk,
      admit: async () => {},
      produce: async () => ({
        output: { proposal, outcome: proposal ? "pick" : "none" },
        model: projection.model ?? "synthetic",
      }),
    },
    input,
    {
      runId: projection.runId ?? undefined,
      record: { entity: projection.entity, id: projection.recordId },
    },
  );
  const [row] = await getDb(db)
    .select({ id: ask.id, inputHash: answer.inputHash })
    .from(ask)
    .innerJoin(answer, eq(answer.askId, ask.id))
    .where(
      sql`${ask.input}->${"input"}->'row'->>'synthetic'=${input.row.synthetic}`,
    );
  if (!row) throw new Error("Synthetic Answer missing");
  const subject = `${projection.entity}:${projection.recordId}`;
  const used = [{ kind: "answer", inputHash: row.inputHash }];
  const gaps =
    proposal && plan
      ? [
          {
            kind: "decision",
            input: "Review field",
            actor: { kind: "member" },
            actions: [
              {
                channel: "assignment",
                kind: "set",
                subject,
                field: projection.field,
                value: proposal.value,
              },
            ],
          },
        ]
      : [];
  await getDb(db)
    .execute(sql`INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage, inputs, gaps)
    VALUES ('fields', ${subject}, 1, 'synthetic', ${"needs_you"}, ${JSON.stringify(used)}::jsonb, ${JSON.stringify(gaps)}::jsonb)
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET inputs="ScopeState".inputs || excluded.inputs, gaps="ScopeState".gaps || excluded.gaps`);
  await getDb(db).execute(
    sql`DELETE FROM "ScopeDirty" WHERE "scopeKind"=${"fields"} AND "scopeKey"=${subject}`,
  );
  return {
    ...projection,
    id: row.id,
    fingerprint: row.id,
    family: "field" as const,
  };
}
