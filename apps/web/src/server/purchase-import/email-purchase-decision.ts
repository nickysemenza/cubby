import type { ActorContext } from "@cubby/schemas/context";
import {
  emailPurchaseDecisionInput,
  emailPurchaseDecisionOut,
  type EmailPurchaseDecisionInput,
} from "@cubby/schemas/email-actions";
import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import {
  parseEntityId,
  parseShortcodeFor,
  userId,
} from "@cubby/schemas/identifiers";
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  email as emailTable,
  ledgerParty,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  foldPurchaseLinks,
  readEmailPurchaseEvidence,
} from "~/server/repo/email-purchase-links";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { ensureMailVendorAccount } from "./gmail/mail-account";
import {
  recordEmailClassificationObservation,
  snapshotStoredEmailPrediction,
} from "./gmail/observations";

/**
 * A member links or dismisses one Email for one Purchase. A concurrent
 * agent or import link can commit between this transaction's read and its
 * insert and win the one-link-per-event index; the member's choice must still
 * win, so that one conflict retries once, now seeing (and demoting) it.
 */
export async function decideEmailPurchase(
  db: Database,
  rawInput: EmailPurchaseDecisionInput,
  actor: ActorContext,
) {
  const input = emailPurchaseDecisionInput.parse(rawInput);
  try {
    return await decideOnce(db, input, actor);
  } catch (error) {
    if (
      input.decision !== "linked" ||
      !isUniqueViolation(error, "OrderMailCandidateDecision_one_link_key")
    )
      throw error;
    return decideOnce(db, input, actor);
  }
}

type EventChoice = {
  proposedBy: EmailLinkProposer | null;
  kind: "linked" | "dismissed" | "suggested" | "manual";
};

async function decideOnce(
  db: Database,
  input: EmailPurchaseDecisionInput,
  actor: ActorContext,
) {
  if (actor.runId)
    throw new Error(
      "Only a member reviews an Email's Purchase link; agents use mail.resolve.",
    );
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  return withTransaction(db, async (tx) => {
    // Owner-first lock order, as every Email writer: the member's Email row,
    // then its retained original, then the Purchase.
    const [owned] = await tx
      .select({ email: emailTable })
      .from(emailTable)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, emailTable.ledgerPartyId),
          eq(ledgerParty.userId, userId.parse(actor.userId)),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(emailTable.shortcode, parseShortcodeFor("email", input.id)),
          notDeleted(emailTable),
        ),
      )
      .for("update", { of: emailTable })
      .limit(1);
    if (!owned)
      throw new Error(
        "Only the Email's owner can link or dismiss it for a Purchase.",
      );
    const email = owned.email;
    if (email.checksum !== input.expectedChecksum)
      throw new Error("Email evidence changed; refresh before deciding.");
    if (!email.orderMailId)
      throw new Error(
        "This Email has no retained order events to link; retrieve its original first.",
      );
    const [original] = await tx
      .select({ rawChecksum: orderMail.rawChecksum })
      .from(orderMail)
      .where(
        and(
          eq(orderMail.id, email.orderMailId),
          eq(orderMail.ledgerPartyId, email.ledgerPartyId),
        ),
      )
      .for("update")
      .limit(1);
    if (!original || original.rawChecksum !== input.expectedChecksum)
      throw new Error("Email evidence changed; refresh before deciding.");
    const [target] = await tx
      .select({
        vendorId: purchase.vendorId,
        accountPartyId: vendorAccount.ledgerPartyId,
      })
      .from(purchase)
      .leftJoin(
        vendorAccount,
        and(
          eq(vendorAccount.id, purchase.vendorAccountId),
          notDeleted(vendorAccount),
        ),
      )
      .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
      .for("update", { of: purchase })
      .limit(1);
    if (!target) throw new Error(`${input.purchaseId} no longer exists.`);
    if (target.accountPartyId && target.accountPartyId !== email.ledgerPartyId)
      throw new Error(
        "The Email and the Purchase belong to different members.",
      );

    const evidence = (
      await readEmailPurchaseEvidence(tx, [parseEntityId("email", email.id)], {
        kind: "purchase",
        purchaseId,
      })
    ).filter((row) => row.purchaseId === purchaseId);
    if (
      input.decision === "dismissed" &&
      evidence.some((row) => row.kind === "accepted")
    )
      throw new Error(
        `An import accepted this Email as ${input.purchaseId}'s source; correct the Purchase through reconciliation instead.`,
      );
    // The order events this pair rests on: suggested ones and ones already
    // decided for this Purchase. Never every event of the Email: a member's
    // link to an unsuggested Purchase takes the Email's one active event,
    // and an Email with several events needs mail.resolve to name them.
    const events = new Map<string, EventChoice>();
    for (const row of evidence)
      if (row.eventId && row.kind !== "accepted")
        events.set(row.eventId, { proposedBy: row.proposedBy, kind: row.kind });
    if (events.size === 0 && input.decision === "linked") {
      const active = await tx
        .select({ id: orderMailEvent.id })
        .from(orderMailEvent)
        .where(
          and(
            eq(orderMailEvent.orderMailId, email.orderMailId),
            isNull(orderMailEvent.supersededAt),
          ),
        )
        .limit(2);
      const [only] = active;
      if (!only || active.length > 1)
        throw new Error(
          `This Email has ${active.length === 0 ? "no" : "several"} order events and none matches ${input.purchaseId}; link it with mail.resolve, which names the event.`,
        );
      events.set(only.id, { proposedBy: "member", kind: "manual" });
    }
    if (events.size === 0)
      throw new Error(`Nothing links this Email to ${input.purchaseId}.`);
    const eventIds = [...events.keys()];

    if (input.decision === "linked") {
      await ensureMailVendorAccount(tx, {
        vendorId: target.vendorId,
        ledgerPartyId: email.ledgerPartyId,
      });
      // One linked Purchase per event: this member's link replaces another.
      await tx
        .update(orderMailCandidateDecision)
        .set({ decision: "dismissed", updatedAt: new Date() })
        .where(
          and(
            inArray(orderMailCandidateDecision.eventId, eventIds),
            eq(orderMailCandidateDecision.decision, "linked"),
            ne(orderMailCandidateDecision.purchaseId, purchaseId),
          ),
        );
    }
    for (const [eventId, row] of events)
      await tx
        .insert(orderMailCandidateDecision)
        .values({
          eventId,
          purchaseId: parseEntityId("purchase", purchaseId),
          decision: input.decision,
          evidenceChecksum: input.expectedChecksum,
          decidedByUserId: actor.userId,
          // A suggestion the member acted on was the heuristic's proposal.
          proposedBy: row.kind === "suggested" ? "heuristic" : row.proposedBy,
        })
        .onConflictDoUpdate({
          target: [
            orderMailCandidateDecision.eventId,
            orderMailCandidateDecision.purchaseId,
          ],
          // An existing decision keeps its proposer: a dismissed agent link
          // stays an agent proposal the member rejected.
          set: {
            decision: input.decision,
            evidenceChecksum: input.expectedChecksum,
            decidedByUserId: actor.userId,
            updatedAt: new Date(),
          },
        });

    // A member's link is relevance evidence (ADR 0011): the Email is related.
    if (input.decision === "linked" && email.classification !== "related") {
      const reason = `Linked to ${input.purchaseId} by the member.`;
      await snapshotStoredEmailPrediction(tx, email);
      await recordEmailClassificationObservation(databaseForTransaction(tx), {
        emailId: email.id,
        checksum: email.checksum,
        classification: "related",
        stage: "resolution",
        reason,
        classificationVersion: MAILBOX_RESEARCH_VERSION,
      });
      await getDb(databaseForTransaction(tx))
        .update(emailTable)
        .set({
          classification: "related",
          classificationStage: "resolution",
          classificationReason: reason,
          classificationVersion: MAILBOX_RESEARCH_VERSION,
          updatedAt: new Date(),
        })
        .where(eq(emailTable.id, email.id));
    }

    const link = foldPurchaseLinks(
      await readEmailPurchaseEvidence(
        tx,
        [parseEntityId("email", email.id)],
        null,
      ),
    ).find((pair) => pair.purchaseId === input.purchaseId);
    return emailPurchaseDecisionOut.parse({
      id: input.id,
      purchaseId: input.purchaseId,
      state: link?.state ?? "none",
    });
  });
}
