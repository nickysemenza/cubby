import type { ActorContext } from "@cubby/schemas/context";
import {
  emailPurchaseDecisionInput,
  emailPurchaseDecisionOut,
  type EmailPurchaseDecisionInput,
} from "@cubby/schemas/email-actions";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  email,
  ledgerParty,
  orderMailEvent,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { publishEmailLinkDecision } from "~/server/domains/email/repo/email-link-decision";
import { readExactOrderLinkCandidates } from "~/server/domains/email/repo/email-purchase-links";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  householdWrite,
  decide,
  reconcileNow,
  recordSubject,
} from "~/server/kernel/api";

/** The reviewed checksum guards the member's root decision against stale source evidence. */
export async function decideEmailPurchase(
  db: Database,
  raw: EmailPurchaseDecisionInput,
  actor: ActorContext,
  options: {
    eventId?: string;
    originalId?: string;
    expectedDecisionId?: string;
  } = {},
) {
  const input = emailPurchaseDecisionInput.parse(raw);
  if (actor.runId)
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "Only a member reviews an Email's Purchase link.",
    );
  return householdWrite(db, async (database) => {
    const q = repositoryQueries(database);
    const purchaseId = await resolveOrThrow(
      database,
      "purchase",
      input.purchaseId,
    );
    const [mail] = await q
      .select({ row: email, owner: ledgerParty.userId })
      .from(email)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, email.ledgerPartyId),
          isNull(ledgerParty.deletedAt),
        ),
      )
      .where(
        and(
          eq(email.shortcode, parseShortcodeFor("email", input.id)),
          isNull(email.deletedAt),
        ),
      )
      .limit(1);
    if (!mail || mail.owner !== actor.userId)
      throw createAppError(
        "EMAIL_NOT_FOUND",
        "Only the Email's owner can review its Purchase link.",
      );
    if (
      mail.row.checksum !== input.expectedChecksum ||
      (options.originalId && mail.row.orderMailId !== options.originalId)
    )
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "Email evidence changed; refresh before deciding.",
      );
    const [target] = await q
      .select({ row: purchase, owner: vendorAccount.ledgerPartyId })
      .from(purchase)
      .leftJoin(
        vendorAccount,
        and(
          eq(vendorAccount.id, purchase.vendorAccountId),
          isNull(vendorAccount.deletedAt),
        ),
      )
      .where(and(eq(purchase.id, purchaseId), isNull(purchase.deletedAt)))
      .limit(1);
    if (!target || (target.owner && target.owner !== mail.row.ledgerPartyId))
      throw createAppError(
        "MAIL_REQUEST_REFUSED",
        "The Purchase must be live and available to the Email's owner.",
      );
    const events = mail.row.orderMailId
      ? await q
          .select({ id: orderMailEvent.id })
          .from(orderMailEvent)
          .where(
            and(
              eq(orderMailEvent.orderMailId, mail.row.orderMailId),
              isNull(orderMailEvent.supersededAt),
              options.eventId
                ? eq(orderMailEvent.id, options.eventId)
                : undefined,
            ),
          )
          .limit(2)
      : [];
    const event = events[0];
    if (!event || events.length !== 1)
      throw createAppError(
        "MAIL_REQUEST_REFUSED",
        "Name the order event when an Email describes several orders.",
      );
    await publishEmailLinkDecision(
      database,
      {
        eventId: event.id,
        purchaseId: parseEntityId("purchase", purchaseId),
        decision: input.decision,
        evidenceChecksum: input.expectedChecksum,
        decidedByUserId: actor.userId,
        proposedBy: "member",
      },
      "member",
      options.expectedDecisionId
        ? { decisionId: options.expectedDecisionId, emailId: mail.row.id }
        : undefined,
    );
    if (input.decision === "linked")
      await decide(database, actor, [
        {
          channel: "assignment",
          kind: "set",
          subject: recordSubject("email", mail.row.id),
          field: "classification",
          value: "related",
          scopes: [{ kind: "emailState", key: mail.row.id }],
        },
      ]);
    await republishEmailRelationship(database, mail.row.id);
    return emailPurchaseDecisionOut.parse({
      id: input.id,
      purchaseId: input.purchaseId,
      state: input.decision,
    });
  });
}

export async function republishEmailRelationship(
  db: Database,
  emailId: string,
) {
  await reconcileNow(db, [{ kind: "emailState", key: emailId }]);
}

/** Exact links are derived from evidence; this entry point only dirties and settles their scopes. */
export async function linkExactOrderEmails(
  db: Database,
  scope: { emailIds: readonly string[] } | { purchaseIds: readonly string[] },
): Promise<number> {
  const candidates = await readExactOrderLinkCandidates(db, scope);
  const ids =
    "emailIds" in scope
      ? scope.emailIds
      : [...new Set(candidates.map((row) => row.emailId))];
  await reconcileNow(
    db,
    ids.map((key) => ({ kind: "emailState", key })),
  );
  return candidates.length;
}
