import type { VendorId } from "@cubby/schemas/identifiers";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { systemActor } from "~/server/runs/ensure-run";

/**
 * Link every current order-mail event for one Vendor order to its one live
 * Purchase, recorded as a `cubby-system` decision so the worklist shows it
 * linked without a member click. Runs whichever arrives last: mail processing
 * when the Purchase already exists, and the import writer when the mail does.
 *
 * Eligibility matches mail processing's exact target: the mail's member owns
 * the Purchase's account, or the Purchase has no account and only one member
 * has this Vendor. An event with any decision on this Purchase (including a
 * member's dismissal) or a link elsewhere is left alone.
 */
export async function linkExactOrderMail(
  db: Database | DrizzleTransaction,
  input: { vendorId: VendorId; orderId: string },
) {
  const database = unwrapDb(db);
  const targets = await database
    .select({ id: purchase.id, accountPartyId: vendorAccount.ledgerPartyId })
    .from(purchase)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, purchase.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(
      and(
        eq(purchase.vendorId, input.vendorId),
        eq(purchase.orderId, input.orderId),
        notDeleted(purchase),
      ),
    )
    .limit(2);
  const [target] = targets;
  if (!target || targets.length > 1) return 0;

  if (!target.accountPartyId) {
    const members = await database
      .selectDistinct({ ledgerPartyId: vendorAccount.ledgerPartyId })
      .from(vendorAccount)
      .where(
        and(
          eq(vendorAccount.vendorId, input.vendorId),
          notDeleted(vendorAccount),
        ),
      );
    if (members.length > 1) return 0;
  }

  const decided = database
    .select({ eventId: orderMailCandidateDecision.eventId })
    .from(orderMailCandidateDecision)
    .where(
      sql`${orderMailCandidateDecision.purchaseId} = ${target.id} OR ${orderMailCandidateDecision.decision} = 'linked'`,
    );
  const events = await database
    .select({ eventId: orderMailEvent.id, checksum: orderMail.rawChecksum })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .where(
      and(
        eq(orderMail.vendorId, input.vendorId),
        eq(orderMailEvent.orderId, input.orderId),
        isNull(orderMailEvent.supersededAt),
        target.accountPartyId
          ? eq(orderMail.ledgerPartyId, target.accountPartyId)
          : undefined,
        notInArray(orderMailEvent.id, decided),
      ),
    );
  if (events.length === 0) return 0;
  const inserted = await database
    .insert(orderMailCandidateDecision)
    .values(
      events.map((event) => ({
        eventId: event.eventId,
        purchaseId: target.id,
        decision: "linked" as const,
        evidenceChecksum: event.checksum,
        decidedByUserId: systemActor().userId,
      })),
    )
    // A concurrent member decision wins; this pass simply skips that event.
    .onConflictDoNothing()
    .returning({ id: orderMailCandidateDecision.id });
  return inserted.length;
}
