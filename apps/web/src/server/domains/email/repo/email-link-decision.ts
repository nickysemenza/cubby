import { buildActorContext } from "@cubby/schemas/context";
import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import { userId, type PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  emailPurchaseDecision,
  orderMailEvent,
} from "~/server/db/retained-tables";
import { decide, householdWrite, recordSubject } from "~/server/kernel/api";

import { emailLinkDecisionsRead } from "./email-decision-sql";

type Decision = typeof emailPurchaseDecision.$inferSelect;

/** A reviewed Email link is a root decision so later extraction events cannot replace it. */
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
): Promise<Decision> {
  return householdWrite(db, async (database) => {
    const q = getDb(database);
    const [subject] = await q
      .select({
        emailId: email.id,
        originalId: orderMailEvent.orderMailId,
        checksum: email.checksum,
      })
      .from(orderMailEvent)
      .innerJoin(email, eq(email.orderMailId, orderMailEvent.orderMailId))
      .where(and(eq(orderMailEvent.id, input.eventId), isNull(email.deletedAt)))
      .limit(1);
    if (!subject || subject.checksum !== input.evidenceChecksum)
      throw new Error("Email evidence changed; refresh before deciding");
    if (expected) {
      const [held] = await q
        .select()
        .from(emailLinkDecisionsRead)
        .where(eq(emailLinkDecisionsRead.id, expected.decisionId));
      if (
        !held?.active ||
        held.emailId !== expected.emailId ||
        held.purchaseId !== input.purchaseId ||
        held.evidenceChecksum !== input.evidenceChecksum
      )
        throw new Error(
          "Email decision evidence is stale; refresh before deciding",
        );
    }
    const current = await q
      .select()
      .from(emailLinkDecisionsRead)
      .where(
        and(
          eq(emailLinkDecisionsRead.emailId, subject.emailId),
          eq(emailLinkDecisionsRead.active, true),
        ),
      );
    const previous = current.find((row) => row.purchaseId === input.purchaseId);
    if (
      previous &&
      previous.decision === input.decision &&
      previous.evidenceChecksum === input.evidenceChecksum &&
      previous.authority === authority &&
      previous.decidedByUserId === input.decidedByUserId &&
      previous.proposedBy === input.proposedBy
    )
      return previous;
    const member = current.find(
      (row) => row.authority === "member" && row.decision === "linked",
    );
    if (authority === "automatic" && member) return member;
    const root = recordSubject("email", subject.emailId);
    const value = { ...input, originalId: subject.originalId };
    const [ref] = await decide(
      database,
      buildActorContext(
        userId.parse(input.decidedByUserId),
        authority === "member" ? "web" : "system",
      ),
      [
        {
          channel: "assignment",
          kind: "set",
          subject: root,
          field: `link:${input.purchaseId}`,
          value,
          scopes: [{ kind: "emailState", key: subject.emailId }],
        },
        ...(input.decision === "linked"
          ? [
              {
                channel: "assignment" as const,
                kind: "set" as const,
                subject: root,
                field: "purchaseId",
                value: input.purchaseId,
              },
              {
                channel: "assignment" as const,
                kind: "set" as const,
                subject: `emailEvent:${input.eventId}`,
                field: "purchaseId",
                value: input.purchaseId,
              },
            ]
          : []),
      ],
    );
    const [row] = await q
      .select()
      .from(emailLinkDecisionsRead)
      .where(eq(emailLinkDecisionsRead.id, ref!.id));
    if (!row) throw new Error("Email link decision returned no row");
    return row;
  });
}

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
