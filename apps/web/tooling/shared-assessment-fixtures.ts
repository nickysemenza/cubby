import { assessmentJudgments } from "@cubby/schemas/assessment";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { feedback } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { recordFeedback } from "~/server/repo/assessment";
import { publishEmailLinkDecision } from "~/server/repo/assessment-email-link";
import { ensureEmailAssessment } from "~/server/repo/assessment-email";

type EmailLinkDecision = Omit<
  Parameters<typeof publishEmailLinkDecision>[1],
  "proposedBy"
> & {
  proposedBy?: Parameters<typeof publishEmailLinkDecision>[1]["proposedBy"];
};

export async function listFeedbackByKind(db: Database, kind: string) {
  return getDb(db)
    .select()
    .from(feedback)
    .where(sql`${feedback.metadata} @> ${JSON.stringify({ kind })}::jsonb`);
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

/** Replace the retired label fixture with member Feedback on its Assessment. */
export async function seedEmailClassificationFeedback(
  db: Database,
  input: {
    predictionId: string;
    classification: "related" | "unrelated" | "uncertain";
    reason: string | null;
    actorUserId: string | null;
    authority?: "member" | "evaluation";
  },
) {
  const prediction = await ensureEmailAssessment(db, input.predictionId);
  const predicted = assessmentJudgments.email_relevance.parse(
    prediction.judgment,
  ).classification;
  const authority = input.authority ?? "member";
  return recordFeedback(db, {
    assessmentId: prediction.id,
    operationId: `email-classification-review:${input.predictionId}:${randomUUID()}`,
    verdict:
      input.classification === "uncertain"
        ? "uncertain"
        : input.classification === predicted
          ? "correct"
          : "wrong",
    correction: { present: true, value: input.classification },
    reason: input.reason,
    intent: authority === "evaluation" ? "history" : "apply",
    authority,
    actorUserId: input.actorUserId,
    metadata: {
      kind: "email_classification_review",
      predictionId: input.predictionId,
    },
  });
}
