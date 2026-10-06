import { buildActorContext } from "@cubby/schemas/context";
import {
  userId,
  type LedgerPartyId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ledgerParty,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  run as runTable,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

import { ownersOf, startOrderMailImport } from "./import";

const log = createLogger("order-mail-auto-import");

/**
 * Most confirmations one Vendor auto-imports in one pass. A first pass over a
 * mailbox can save a backlog of old placements; past the cap they wait in the
 * Vendor's order-mail worklist for a click instead of flooding the agent.
 */
export const AUTO_IMPORTS_PER_VENDOR = 5;

/**
 * Start an order import for each new confirmation a scheduled Gmail pass just
 * saved, as the mailbox's member with `trigger: discovery`. A confirmation is
 * new when its order has no Purchase, no member decision, and no live run
 * owns it. Replaying a batch returns the runs the first delivery started, so
 * the cap counts them and no second run starts. A failure to start one order
 * is logged and never fails the pass: the confirmation stays in the worklist.
 */
export async function autoImportOrderMail(
  db: Database,
  input: { ledgerPartyId: LedgerPartyId; messageIds: readonly string[] },
  queue: PurchaseAgentQueueProducer,
) {
  if (input.messageIds.length === 0) return [];
  const database = getDb(db);
  const [member] = await database
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(
      and(eq(ledgerParty.id, input.ledgerPartyId), notDeleted(ledgerParty)),
    )
    .limit(1);
  if (!member?.userId) return [];
  const actor = buildActorContext(userId.parse(member.userId), "system");

  const placements = await database
    .select({
      eventId: orderMailEvent.id,
      orderId: orderMailEvent.orderId,
      vendorId: orderMail.vendorId,
      checksum: orderMail.rawChecksum,
    })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .where(
      and(
        eq(orderMail.ledgerPartyId, input.ledgerPartyId),
        inArray(orderMail.messageId, [...input.messageIds]),
        isNotNull(orderMail.vendorId),
        eq(orderMailEvent.event, "placed"),
        isNotNull(orderMailEvent.orderId),
        isNull(orderMailEvent.supersededAt),
      ),
    )
    .orderBy(asc(orderMail.receivedAt), asc(orderMailEvent.id));

  const started: string[] = [];
  const perVendor = new Map<VendorId, number>();
  for (const placement of placements) {
    const { vendorId, orderId } = placement;
    if (!vendorId || !orderId) continue;
    if ((perVendor.get(vendorId) ?? 0) >= AUTO_IMPORTS_PER_VENDOR) continue;
    if (!(await isNewConfirmation(db, { ...placement, vendorId, orderId })))
      continue;
    // The run an earlier delivery of this batch started is reused, not
    // refused as an owner.
    const [own] = await database
      .select({ id: runTable.id })
      .from(runTable)
      .where(
        eq(
          runTable.clientKey,
          `order-mail:${placement.eventId}:${placement.checksum}`,
        ),
      )
      .limit(1);
    if (!own) {
      const owners = await withTransaction(db, (tx) =>
        ownersOf(tx, { ledgerPartyId: input.ledgerPartyId, vendorId }, [
          placement.eventId,
        ]),
      );
      if (owners.size > 0) continue;
    }
    try {
      const { runId } = await startOrderMailImport(
        db,
        { eventId: placement.eventId, evidenceChecksum: placement.checksum },
        actor,
        queue,
        "discovery",
      );
      started.push(runId);
      perVendor.set(vendorId, (perVendor.get(vendorId) ?? 0) + 1);
    } catch (error) {
      log.warn("Order confirmation auto-import skipped", {
        orderId,
        error,
      });
    }
  }
  return started;
}

/** No live Purchase has this order, and the member decided nothing on it. */
async function isNewConfirmation(
  db: Database,
  placement: { eventId: string; vendorId: VendorId; orderId: string },
) {
  const database = getDb(db);
  const [existing] = await database
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.vendorId, placement.vendorId),
        eq(purchase.orderId, placement.orderId),
        notDeleted(purchase),
      ),
    )
    .limit(1);
  if (existing) return false;
  const [decided] = await database
    .select({ id: orderMailCandidateDecision.id })
    .from(orderMailCandidateDecision)
    .where(eq(orderMailCandidateDecision.eventId, placement.eventId))
    .limit(1);
  return !decided;
}
