import { buildActorContext } from "@cubby/schemas/context";
import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import { userId, type PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { decision as storedDecision } from "~/server/db/kernel-schema";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  emailPurchaseDecision,
  orderMailEvent,
} from "~/server/db/retained-tables";
import {
  emailLinkDecisionsReadForDecision,
  emailLinkDecisionsReadForEmail,
} from "~/server/domains/email/repo/email-decision-sql";
import { decide, householdWrite, recordSubject } from "~/server/kernel/api";

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
        eventId: orderMailEvent.id,
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
      const heldLinks = emailLinkDecisionsReadForDecision(
        sql`${expected.decisionId}`,
      );
      const [held] = await q
        .select()
        .from(heldLinks)
        .where(eq(heldLinks.id, expected.decisionId));
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
    const links = emailLinkDecisionsReadForEmail(sql`${subject.emailId}::uuid`);
    const current = await q
      .select()
      .from(links)
      .where(and(eq(links.emailId, subject.emailId), eq(links.active, true)));
    // The resolved uuid, not the caller's spelling: scoped reads compare the
    // stored `eventId` to OrderMailEvent ids as exact text.
    const eventId = subject.eventId;
    const previous = current.find((row) => row.purchaseId === input.purchaseId);
    if (
      previous &&
      previous.eventId === eventId &&
      previous.decision === input.decision &&
      previous.evidenceChecksum === input.evidenceChecksum &&
      previous.authority === authority &&
      previous.decidedByUserId === input.decidedByUserId &&
      previous.proposedBy === input.proposedBy
    )
      return previous;
    const member = current.find(
      (row) =>
        row.authority === "member" &&
        row.decision === "linked" &&
        row.eventId === eventId,
    );
    if (authority === "automatic" && member) return member;
    const root = recordSubject("email", subject.emailId);
    const value = { ...input, eventId, originalId: subject.originalId };
    // A member changes the canonical target's choice, including choices made
    // before a merge. Automatic publishers must preserve those older choices.
    const aliases =
      authority === "member"
        ? await q
            .select({ field: storedDecision.field })
            .from(storedDecision)
            .innerJoin(
              entityIdentity,
              sql`${storedDecision.field} = 'link:' || ${entityIdentity.id}::text`,
            )
            .where(
              and(
                eq(storedDecision.subject, root),
                eq(storedDecision.channel, "assignment"),
                eq(entityIdentity.mergedIntoId, input.purchaseId),
              ),
            )
        : [];
    const actor = buildActorContext(
      userId.parse(input.decidedByUserId),
      authority === "member" ? "web" : "system",
    );
    if (aliases.length)
      await decide(
        database,
        actor,
        [...new Set(aliases.map((row) => row.field!))].map((field) => ({
          channel: "assignment",
          kind: "none",
          subject: root,
          field,
          scopes: [{ kind: "emailState", key: subject.emailId }],
        })),
      );

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
                subject: `emailEvent:${eventId}`,
                field: "purchaseId",
                value: input.purchaseId,
              },
            ]
          : []),
      ],
    );
    const [row] = await q.select().from(links).where(eq(links.id, ref!.id));
    if (!row) throw new Error("Email link decision returned no row");
    return row;
  });
}
