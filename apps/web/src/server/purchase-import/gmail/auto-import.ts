import { buildActorContext } from "@cubby/schemas/context";
import {
  userId,
  type LedgerPartyId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

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
 * owns it.
 *
 * The cap counts the automatic runs admitted for the member and Vendor since
 * the pass started (`since`), not this call: a pass calls once per batch, and
 * a retried batch must not admit orders an earlier attempt left capped. A
 * replayed batch reuses the run it admitted, redispatching one whose dispatch
 * failed. Any failure to admit or dispatch is rethrown after the rest of the
 * batch, so the Workflow step retries it instead of moving the cursor past it.
 */
export async function autoImportOrderMail(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    messageIds: readonly string[];
    since: Date;
  },
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
        // The import refuses a confirmation with no body to extract.
        sql`coalesce(${orderMail.content}->>'bodyText', ${orderMail.content}->>'bodyHtml') IS NOT NULL`,
        eq(orderMailEvent.event, "placed"),
        isNotNull(orderMailEvent.orderId),
        isNull(orderMailEvent.supersededAt),
      ),
    )
    .orderBy(asc(orderMail.receivedAt), asc(orderMailEvent.id));

  const started: string[] = [];
  const failures: string[] = [];
  for (const placement of placements) {
    const { vendorId, orderId } = placement;
    if (!vendorId || !orderId) continue;
    // The run an earlier delivery of this batch admitted is reused, not
    // refused as an owner or counted against the cap again.
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
      if (
        (await admittedSince(db, { ...input, vendorId })) >=
        AUTO_IMPORTS_PER_VENDOR
      )
        continue;
      if (!(await isNewConfirmation(db, { ...placement, vendorId, orderId })))
        continue;
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
    } catch (error) {
      failures.push(
        `order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(
      `Automatic import failed to start ${failures.length} order(s): ${failures.join("; ")}`,
    );
  return started;
}

/** Automatic mail imports admitted for this member and Vendor since `since`. */
async function admittedSince(
  db: Database,
  scope: { ledgerPartyId: LedgerPartyId; vendorId: VendorId; since: Date },
) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(runTable)
    .where(
      and(
        eq(runTable.ledgerPartyId, scope.ledgerPartyId),
        eq(runTable.vendorId, scope.vendorId),
        eq(runTable.trigger, "discovery"),
        sql`${runTable.input}->>'kind' = 'order_mail_import'`,
        gte(runTable.startedAt, scope.since),
      ),
    );
  return row?.count ?? 0;
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
