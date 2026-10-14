import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { assessmentState, email, orderMailEvent } from "~/server/db/schema";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import { getDb } from "~/server/repo/database-helpers";

export async function publishEmailLinkDecision(
  db: Database,
  input: {
    eventId: string;
    purchaseId: PurchaseId;
    decision: "linked" | "dismissed";
    evidenceChecksum: string;
    decidedByUserId: string;
    proposedBy: EmailLinkProposer | null;
  },
  authority: "member" | "automatic" = "member",
) {
  const client = getDb(db);
  const [subject] = await client
    .select({ emailId: email.id, originalId: orderMailEvent.orderMailId })
    .from(orderMailEvent)
    .innerJoin(email, eq(email.orderMailId, orderMailEvent.orderMailId))
    .where(eq(orderMailEvent.id, input.eventId))
    .limit(1);
  if (!subject) throw new Error("Email event has no durable Email subject");
  const prediction = await publishAssessment(
    db,
    {
      publicationKey: `email-link:${crypto.randomUUID()}`,
      family: "email_link",
      subject: {
        kind: "email_link",
        entity: "email",
        recordId: subject.emailId,
        originalId: subject.originalId,
        eventId: input.eventId,
        purchaseId: input.purchaseId,
        checksum: input.evidenceChecksum,
      },
      judgment: { decision: input.decision },
      producer:
        input.proposedBy && input.proposedBy !== "member"
          ? {
              kind: input.proposedBy === "heuristic" ? "rule" : "agent",
              model: null,
              revision: null,
              runId: null,
              evaluationId: null,
            }
          : null,
      fingerprint: input.evidenceChecksum,
      evidence: null,
    },
    { data: input, active: false },
  );
  await recordFeedback(db, {
    assessmentId: prediction.id,
    operationId: "decision",
    verdict: input.decision === "linked" ? "correct" : "dismissed",
    intent: input.decision === "linked" ? "apply" : "history",
    authority,
    actorUserId: input.decidedByUserId,
    correction: { present: true, value: input.decision },
    metadata: {
      kind: "email_link",
      eventId: input.eventId,
      purchaseId: input.purchaseId,
    },
  });
  // Current authority can move, while every historical decision stays bound to its original event.
  await client
    .update(assessmentState)
    .set({ active: false, status: "superseded" })
    .where(
      and(
        eq(assessmentState.family, "email_link"),
        sql`${assessmentState.data}->>'eventId' = ${input.eventId}`,
        sql`${assessmentState.id} <> ${prediction.id}`,
        input.decision === "linked"
          ? sql`(${assessmentState.data} @> ${JSON.stringify({ decision: "linked" })}::jsonb OR ${assessmentState.data}->>'purchaseId' = ${input.purchaseId})`
          : sql`${assessmentState.data}->>'purchaseId' = ${input.purchaseId}`,
      ),
    );
  await client
    .update(assessmentState)
    .set({ status: "resolved", active: true })
    .where(eq(assessmentState.id, prediction.id));
  return prediction;
}
