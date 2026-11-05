import type { AssessmentProducer } from "@cubby/schemas/assessment";
import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import { parseEntityId, type PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
  type RepositoryQueryTransaction as DrizzleTransaction,
} from "~/server/db/repository-access.boundary";
import {
  email,
  emailPurchaseDecision,
  orderMailEvent,
} from "~/server/db/retained-tables";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";
import { recordChange } from "~/server/generic/changes/repo/change";

type Decision = typeof emailPurchaseDecision.$inferSelect;

/**
 * The one writer of an event's Purchase decisions. The event advisory lock and
 * row lock serialize direct publishers before current authority is read; a
 * member's stale evidence is refused, and repeating the same decision is a
 * no-op. Each decision also appends its retained review.
 */
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
  expected?: { decisionId: string; emailId: string },
  /** The revision and Run of the rule that settled a `heuristic` link automatically. */
  rule?: { revision: string; runId: string | null },
): Promise<Decision> {
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
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
      .select()
      .from(emailPurchaseDecision)
      .where(
        and(
          eq(emailPurchaseDecision.eventId, input.eventId),
          eq(emailPurchaseDecision.active, true),
        ),
      )
      .orderBy(emailPurchaseDecision.id);
    if (expected) {
      // Parent locks are already held by the member action; this event lock
      // also serializes direct publishers before checking current authority.
      const reviewed = current.find((row) => row.id === expected.decisionId);
      if (
        !reviewed ||
        reviewed.emailId !== expected.emailId ||
        reviewed.status === "superseded" ||
        reviewed.status === "applied" ||
        reviewed.purchaseId !== input.purchaseId ||
        reviewed.evidenceChecksum !== input.evidenceChecksum
      )
        throw new Error(
          "Assessment evidence is stale; request a fresh assessment before applying",
        );
    }
    const previous = current.find((row) => row.purchaseId === input.purchaseId);
    if (
      previous &&
      previous.decision === input.decision &&
      previous.evidenceChecksum === input.evidenceChecksum &&
      previous.decidedByUserId === input.decidedByUserId &&
      previous.proposedBy === input.proposedBy &&
      previous.authority === authority
    )
      return previous;
    const producer: AssessmentProducer | null =
      input.proposedBy && input.proposedBy !== "member"
        ? {
            kind: input.proposedBy === "heuristic" ? "rule" : "agent",
            model: null,
            revision: rule?.revision ?? null,
            runId: rule?.runId ? parseEntityId("run", rule.runId) : null,
            evaluationId: null,
          }
        : null;
    // Current authority can move, while every historical decision stays bound to its original event.
    await client
      .update(emailPurchaseDecision)
      .set({ active: false, status: "superseded" })
      .where(
        and(
          eq(emailPurchaseDecision.eventId, input.eventId),
          eq(emailPurchaseDecision.active, true),
          input.decision === "linked"
            ? or(
                eq(emailPurchaseDecision.decision, "linked"),
                eq(emailPurchaseDecision.purchaseId, input.purchaseId),
              )
            : eq(emailPurchaseDecision.purchaseId, input.purchaseId),
        ),
      );
    const [inserted] = await client
      .insert(emailPurchaseDecision)
      .values({
        eventId: input.eventId,
        purchaseId: input.purchaseId,
        decision: input.decision,
        evidenceChecksum: input.evidenceChecksum,
        decidedByUserId: input.decidedByUserId,
        proposedBy: input.proposedBy,
        authority,
        emailId: subject.emailId,
        originalId: subject.originalId,
        producer,
      })
      .returning();
    if (!inserted) throw new Error("Email link decision returned no row");
    await appendEmailReview(transactionDb, {
      family: "email_link",
      subjectId: inserted.id,
      emailId: subject.emailId,
      originalId: subject.originalId,
      checksum: input.evidenceChecksum,
      operationId: "decision",
      verdict: input.decision === "linked" ? "correct" : "dismissed",
      correction: { present: true, value: { decision: input.decision } },
      intent: input.decision === "linked" ? "apply" : "history",
      authority,
      actorUserId: input.decidedByUserId,
      subject: emailLinkSubject(inserted),
      metadata: {
        kind: "email_link",
        eventId: input.eventId,
        purchaseId: input.purchaseId,
      },
    });
    return inserted;
  });
}

/** The retained subject of a decision, as its review history stores it. */
export const emailLinkSubject = (
  row: Pick<
    Decision,
    "emailId" | "originalId" | "eventId" | "purchaseId" | "evidenceChecksum"
  >,
) => ({
  kind: "email_link" as const,
  entity: "email" as const,
  recordId: row.emailId,
  originalId: row.originalId,
  eventId: row.eventId,
  purchaseId: row.purchaseId,
  checksum: row.evidenceChecksum,
});

const notifyDecisions = (db: DrizzleTransaction) =>
  recordChange(db, {
    kind: "projection",
    categories: ["ai", "suggestions", "problems", "email", "purchase"],
  });

/**
 * A removed Email keeps its link review on the retained order event; a removed
 * Purchase retires the decisions about it.
 */
export async function retireEmailDecisionTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
) {
  if (!entityIds.length) return;
  const ids = [...entityIds];
  const moved =
    entityKind === "email"
      ? await tx
          .update(emailPurchaseDecision)
          .set({ emailId: null })
          .where(inArray(emailPurchaseDecision.emailId, ids))
          .returning({ id: emailPurchaseDecision.id })
      : entityKind === "purchase"
        ? await tx
            .update(emailPurchaseDecision)
            .set({ active: false, status: "superseded" })
            .where(
              inArray(
                emailPurchaseDecision.purchaseId,
                ids.map((id) => parseEntityId("purchase", id)),
              ),
            )
            .returning({ id: emailPurchaseDecision.id })
        : [];
  if (moved.length) await notifyDecisions(tx);
}

/**
 * A Purchase merge moves each event's decisions to the survivor: the linked
 * decision wins, then the survivor's own, then the oldest id.
 */
export async function repointEmailDecisionTargetsTx(
  tx: DrizzleTransaction,
  keepId: PurchaseId,
  loserIds: readonly PurchaseId[],
) {
  if (!loserIds.length) return;
  const rows = await tx
    .select()
    .from(emailPurchaseDecision)
    .where(
      and(
        eq(emailPurchaseDecision.active, true),
        inArray(emailPurchaseDecision.purchaseId, [keepId, ...loserIds]),
      ),
    )
    .orderBy(emailPurchaseDecision.id)
    .for("update");
  const events = new Map<string, Decision[]>();
  for (const row of rows)
    events.set(row.eventId, [...(events.get(row.eventId) ?? []), row]);
  for (const values of events.values()) {
    const winner =
      values.find((row) => row.decision === "linked") ??
      values.find((row) => row.purchaseId === keepId) ??
      values[0]!;
    // Inactive first: the (event, Purchase) key admits one active row.
    const losers = values.filter((row) => row.id !== winner.id);
    if (losers.length)
      await tx
        .update(emailPurchaseDecision)
        .set({ active: false, status: "superseded" })
        .where(
          inArray(
            emailPurchaseDecision.id,
            losers.map((row) => row.id),
          ),
        );
    if (winner.purchaseId !== keepId)
      await tx
        .update(emailPurchaseDecision)
        .set({ purchaseId: keepId })
        .where(
          and(
            eq(emailPurchaseDecision.id, winner.id),
            ne(emailPurchaseDecision.purchaseId, keepId),
          ),
        );
  }
  if (rows.length) await notifyDecisions(tx);
}
