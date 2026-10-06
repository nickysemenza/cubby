import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ledgerParty,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { ensureMailVendorAccount } from "./mail-account";

const candidateReason = (
  event: { orderId: string | null; amount: number | null; receivedAt: Date },
  candidate: {
    orderId: string | null;
    statedTotal: number | null;
    date: string | null;
  },
) => {
  if (event.orderId && candidate.orderId === event.orderId)
    return "exact_order_id" as const;
  const withinWindow =
    candidate.date !== null &&
    Math.abs(
      event.receivedAt.getTime() - Date.parse(`${candidate.date}T12:00:00Z`),
    ) <=
      45 * 86_400_000;
  if (!withinWindow) return null;
  if (
    event.amount !== null &&
    candidate.statedTotal !== null &&
    Math.abs(event.amount - candidate.statedTotal) < 0.01
  )
    return "amount_and_date" as const;
  return "nearby_date" as const;
};

/** Vendor-wide mail worklist; a member filter narrows both mail and matches. */
export async function listVendorOrderMail(
  db: Database,
  input: { vendorId: string; ledgerPartyId?: string | null },
  options: {
    /** Gmail provider ids returned by the sync pipeline. */
    messageIds?: string[];
    /** OrderMail UUIDs selected by Purchase relationships. */
    orderMailIds?: string[];
  } = {},
) {
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const ledgerPartyId = input.ledgerPartyId
    ? await resolveOrThrow(db, "ledgerParty", input.ledgerPartyId)
    : null;
  const database = getDb(db);
  const members = await database
    .selectDistinct({ id: ledgerParty.shortcode, name: ledgerParty.name })
    .from(orderMail)
    .innerJoin(ledgerParty, eq(ledgerParty.id, orderMail.ledgerPartyId))
    .where(eq(orderMail.vendorId, vendorId));
  const mails = await database
    .select({
      id: orderMail.id,
      ledgerPartyId: orderMail.ledgerPartyId,
      ledgerPartyShortcode: ledgerParty.shortcode,
      messageId: orderMail.messageId,
      threadId: orderMail.threadId,
      sender: orderMail.sender,
      subject: orderMail.subject,
      receivedAt: orderMail.receivedAt,
      rawChecksum: orderMail.rawChecksum,
    })
    .from(orderMail)
    .innerJoin(ledgerParty, eq(ledgerParty.id, orderMail.ledgerPartyId))
    .where(
      and(
        eq(orderMail.vendorId, vendorId),
        exists(
          database
            .select({ id: orderMailEvent.id })
            .from(orderMailEvent)
            .where(
              and(
                eq(orderMailEvent.orderMailId, orderMail.id),
                isNull(orderMailEvent.supersededAt),
                or(
                  eq(orderMailEvent.event, "placed"),
                  eq(orderMailEvent.event, "shipped"),
                  eq(orderMailEvent.event, "delivered"),
                  eq(orderMailEvent.event, "refunded"),
                  isNotNull(orderMailEvent.orderId),
                  isNotNull(orderMailEvent.amount),
                ),
              ),
            ),
        ),
        ledgerPartyId ? eq(orderMail.ledgerPartyId, ledgerPartyId) : undefined,
        options.messageIds
          ? inArray(orderMail.messageId, options.messageIds)
          : undefined,
        options.orderMailIds
          ? inArray(orderMail.id, options.orderMailIds)
          : undefined,
      ),
    )
    .orderBy(desc(orderMail.receivedAt))
    .limit(
      options.messageIds || options.orderMailIds
        ? Math.max(
            options.messageIds?.length ?? options.orderMailIds?.length ?? 0,
            1,
          )
        : 100,
    );
  if (mails.length === 0) return { members, items: [] };
  const events = await database
    .select()
    .from(orderMailEvent)
    .where(
      and(
        inArray(
          orderMailEvent.orderMailId,
          mails.map((mail) => mail.id),
        ),
        isNull(orderMailEvent.supersededAt),
      ),
    );
  const decisions = events.length
    ? await database
        .select()
        .from(orderMailCandidateDecision)
        .where(
          inArray(
            orderMailCandidateDecision.eventId,
            events.map((event) => event.id),
          ),
        )
    : [];
  const orderIds = [
    ...new Set(
      events
        .map((event) => event.orderId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const decidedPurchaseIds = [
    ...new Set(decisions.map((decision) => decision.purchaseId)),
  ];
  const firstMailTime = Math.min(
    ...mails.map((mail) => mail.receivedAt.getTime()),
  );
  const lastMailTime = Math.max(
    ...mails.map((mail) => mail.receivedAt.getTime()),
  );
  const candidateDateFrom = new Date(firstMailTime - 45 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const candidateDateTo = new Date(lastMailTime + 45 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const candidates = await database
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      statedTotal: purchase.statedTotal,
      date: purchase.date,
      vendorAccountId: purchase.vendorAccountId,
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
    .where(
      and(
        eq(purchase.vendorId, vendorId),
        notDeleted(purchase),
        or(
          orderIds.length ? inArray(purchase.orderId, orderIds) : undefined,
          and(
            gte(purchase.date, candidateDateFrom),
            lte(purchase.date, candidateDateTo),
          ),
          decidedPurchaseIds.length
            ? inArray(purchase.id, decidedPurchaseIds)
            : undefined,
        ),
      ),
    );
  const decisionsByPair = new Map(
    decisions.map((decision) => [
      `${decision.eventId}:${decision.purchaseId}`,
      decision.decision,
    ]),
  );
  const eventsByMail = new Map<string, typeof events>();
  for (const event of events) {
    const group = eventsByMail.get(event.orderMailId) ?? [];
    group.push(event);
    eventsByMail.set(event.orderMailId, group);
  }
  return {
    members,
    items: mails.map((mail) => ({
      messageId: mail.messageId,
      threadId: mail.threadId,
      sender: mail.sender,
      subject: mail.subject,
      receivedAt: mail.receivedAt.toISOString(),
      ledgerPartyId: mail.ledgerPartyShortcode,
      events: (eventsByMail.get(mail.id) ?? []).map((event) => ({
        id: event.id,
        event: event.event,
        orderId: event.orderId,
        amount: event.amount,
        currency: event.currency,
        occurredAt: event.occurredAt?.toISOString() ?? null,
        evidenceChecksum: mail.rawChecksum,
        candidates: candidates
          .flatMap((candidate) => {
            if (
              candidate.accountPartyId &&
              candidate.accountPartyId !== mail.ledgerPartyId
            )
              return [];
            const reason = candidateReason(
              { ...event, receivedAt: mail.receivedAt },
              candidate,
            );
            const decision =
              decisionsByPair.get(`${event.id}:${candidate.id}`) ?? null;
            if (!reason && !decision) return [];
            return [
              {
                purchaseId: candidate.shortcode,
                orderId: candidate.orderId,
                statedTotal: candidate.statedTotal,
                date: candidate.date,
                reason: reason ?? ("previous_decision" as const),
                decision,
              },
            ];
          })
          .sort(
            (a, b) =>
              Number(b.decision === "linked") -
                Number(a.decision === "linked") ||
              Number(b.reason === "exact_order_id") -
                Number(a.reason === "exact_order_id") ||
              Number(b.reason === "amount_and_date") -
                Number(a.reason === "amount_and_date"),
          )
          .slice(0, 10),
      })),
    })),
  };
}

export async function listPurchaseOrderMail(
  db: Database,
  input: { purchaseId: string },
) {
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  const database = getDb(db);
  const [target] = await database
    .select({
      id: purchase.id,
      vendorId: purchase.vendorId,
      vendorShortcode: vendor.shortcode,
      orderId: purchase.orderId,
    })
    .from(purchase)
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .limit(1);
  if (!target) throw new Error("Purchase no longer exists");
  const related = await database
    .select({ mailId: orderMail.id })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .leftJoin(
      orderMailCandidateDecision,
      and(
        eq(orderMailCandidateDecision.eventId, orderMailEvent.id),
        eq(orderMailCandidateDecision.purchaseId, target.id),
        eq(orderMailCandidateDecision.decision, "linked"),
      ),
    )
    .where(
      and(
        eq(orderMail.vendorId, target.vendorId),
        isNull(orderMailEvent.supersededAt),
        or(
          target.orderId
            ? eq(orderMailEvent.orderId, target.orderId)
            : undefined,
          eq(orderMailCandidateDecision.purchaseId, target.id),
        ),
      ),
    );
  const mailIds = [...new Set(related.map((row) => row.mailId))];
  if (mailIds.length === 0) return { members: [], items: [] };
  const worklist = await listVendorOrderMail(
    db,
    { vendorId: target.vendorShortcode },
    { orderMailIds: mailIds },
  );
  return {
    members: worklist.members,
    items: worklist.items
      .map((mail) => ({
        ...mail,
        events: mail.events
          .filter((event) =>
            event.candidates.some(
              (candidate) =>
                candidate.purchaseId === input.purchaseId &&
                candidate.decision !== "dismissed",
            ),
          )
          .map((event) => ({
            ...event,
            candidates: event.candidates.filter(
              (candidate) => candidate.purchaseId === input.purchaseId,
            ),
          })),
      }))
      .filter((mail) => mail.events.length > 0),
  };
}

type OrderMailDecisionInput = {
  eventId: string;
  purchaseId: string;
  decision: "linked" | "dismissed";
  evidenceChecksum: string;
};

/**
 * A member's link or dismissal. An automatic exact-order link
 * (`linkExactOrderMail`) can commit between this transaction's read and its
 * insert and win the one-link-per-event index; the member's choice must still
 * win, so that one conflict retries once, now seeing (and demoting) the
 * committed automatic link.
 */
export async function decideOrderMailCandidate(
  db: Database,
  input: OrderMailDecisionInput,
  actor: ActorContext,
) {
  try {
    return await decideOrderMailCandidateOnce(db, input, actor);
  } catch (error) {
    if (
      input.decision !== "linked" ||
      !isUniqueViolation(error, "OrderMailCandidateDecision_one_link_key")
    )
      throw error;
    return decideOrderMailCandidateOnce(db, input, actor);
  }
}

async function decideOrderMailCandidateOnce(
  db: Database,
  input: OrderMailDecisionInput,
  actor: ActorContext,
) {
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.eventId}))`,
    );
    const [lockedPurchase] = await tx
      .select({ id: purchase.id })
      .from(purchase)
      .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
      .for("update");
    if (!lockedPurchase) throw new Error("Purchase no longer exists");
    const [scope] = await tx
      .select({
        eventId: orderMailEvent.id,
        checksum: orderMail.rawChecksum,
        vendorId: orderMail.vendorId,
        ledgerPartyId: orderMail.ledgerPartyId,
        purchaseVendorId: purchase.vendorId,
        purchaseAccountPartyId: vendorAccount.ledgerPartyId,
        vendorName: vendor.name,
      })
      .from(orderMailEvent)
      .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
      .innerJoin(purchase, eq(purchase.id, purchaseId))
      .innerJoin(vendor, eq(vendor.id, orderMail.vendorId))
      .leftJoin(
        vendorAccount,
        and(
          eq(vendorAccount.id, purchase.vendorAccountId),
          notDeleted(vendorAccount),
        ),
      )
      .where(
        and(
          eq(orderMailEvent.id, input.eventId),
          isNull(orderMailEvent.supersededAt),
          notDeleted(purchase),
        ),
      )
      .limit(1);
    if (!scope)
      throw new Error("Order mail event or Purchase no longer exists");
    if (scope.checksum !== input.evidenceChecksum)
      throw new Error("Order mail changed; review its current evidence first");
    const vendorId = scope.vendorId;
    if (!vendorId || vendorId !== scope.purchaseVendorId)
      throw new Error("Order mail and Purchase belong to different Vendors");
    if (
      scope.purchaseAccountPartyId &&
      scope.purchaseAccountPartyId !== scope.ledgerPartyId
    )
      throw new Error("Order mail and Purchase belong to different members");
    if (input.decision === "linked") {
      await ensureMailVendorAccount(tx, {
        vendorId,
        ledgerPartyId: scope.ledgerPartyId,
      });
      await tx
        .update(orderMailCandidateDecision)
        .set({ decision: "dismissed", updatedAt: new Date() })
        .where(
          and(
            eq(orderMailCandidateDecision.eventId, scope.eventId),
            eq(orderMailCandidateDecision.decision, "linked"),
          ),
        );
    }
    await tx
      .insert(orderMailCandidateDecision)
      .values({
        eventId: scope.eventId,
        purchaseId: parseEntityId("purchase", purchaseId),
        decision: input.decision,
        evidenceChecksum: input.evidenceChecksum,
        decidedByUserId: actor.userId,
      })
      .onConflictDoUpdate({
        target: [
          orderMailCandidateDecision.eventId,
          orderMailCandidateDecision.purchaseId,
        ],
        set: {
          decision: input.decision,
          evidenceChecksum: input.evidenceChecksum,
          decidedByUserId: actor.userId,
          updatedAt: new Date(),
        },
      });
    return {
      eventId: scope.eventId,
      purchaseId: input.purchaseId,
      decision: input.decision,
    };
  });
}
