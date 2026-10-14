import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql, isNull } from "drizzle-orm";
import { isEqual } from "es-toolkit";

import type { Database } from "~/server/db";
import {
  assessment,
  assessmentState,
  feedback,
  email,
  orderMailEvent,
} from "~/server/db/schema";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import {
  getDb,
  withTransactionDatabase,
  notDeleted,
} from "~/server/repo/database-helpers";

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
  return withTransactionDatabase(db, async (transactionDb) => {
    db = transactionDb;
    const client = getDb(db);
    await client.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`email-link-event:${input.eventId}`},0))`,
    );
    const [subject] = await client
      .select({ emailId: email.id, originalId: orderMailEvent.orderMailId })
      .from(orderMailEvent)
      .leftJoin(
        email,
        and(
          eq(email.orderMailId, orderMailEvent.orderMailId),
          notDeleted(email),
        ),
      )
      .where(
        and(
          eq(orderMailEvent.id, input.eventId),
          isNull(orderMailEvent.supersededAt),
        ),
      )
      .for("update", { of: orderMailEvent })
      .limit(1);
    if (!subject) throw new Error("Retained Email event no longer exists");
    const current = await client
      .select({
        state: assessmentState,
        prediction: assessment,
        authority: feedback.authority,
        purchaseId: sql<string>`${assessmentState.data}->>'purchaseId'`,
      })
      .from(assessmentState)
      .innerJoin(assessment, eq(assessment.id, assessmentState.id))
      .leftJoin(
        feedback,
        and(
          eq(feedback.assessmentId, assessment.id),
          eq(feedback.operationId, "decision"),
        ),
      )
      .where(
        and(
          eq(assessmentState.family, "email_link"),
          eq(assessmentState.active, true),
          sql`${assessmentState.data}->>'eventId'=${input.eventId}`,
        ),
      )
      .orderBy(assessmentState.id);
    const previous = current.find((row) => row.purchaseId === input.purchaseId);
    if (
      previous &&
      isEqual(previous.state.data, input) &&
      previous.authority === authority
    )
      return previous.prediction;
    const publicationKey = `email-link:${await sha256Hex(JSON.stringify([input, authority, current.map((row) => row.state.id)]))}`;
    const prediction = await publishAssessment(
      db,
      {
        publicationKey,
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
      correction: { present: true, value: { decision: input.decision } },
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
  });
}
