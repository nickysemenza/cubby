import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  type VendorId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import { purchaseOrderMailOut } from "@cubby/schemas/order-mail-review";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  householdDaysAgo,
  householdDaysFromNow,
  householdLocalDate,
  plainDateDaysBetween,
} from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  run,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { lockOwnedResearchSource } from "../research-retention";
import { ensureMailVendorAccount } from "./mail-account";

const mailSourceIdentity = and(
  eq(importSourceClaim.ledgerPartyId, orderMail.ledgerPartyId),
  eq(importSourceClaim.kind, "mail_message"),
  eq(
    importSourceClaim.externalKey,
    sql`'gmail:' || ${orderMail.mailboxId} || ':' || ${orderMail.messageId}`,
  ),
);

/** Source ownership survives a multi-Vendor original and nullable discovery hints. */
const acceptedMailScope = (
  db: ReturnType<typeof getDb>,
  target: {
    vendorId?: VendorId;
    purchaseId?: PurchaseId;
  },
) =>
  exists(
    db
      .select({ id: importSourceOrder.id })
      .from(importSourceClaim)
      .innerJoin(
        importSourceOrder,
        eq(
          importSourceOrder.sourceClaimId,
          sql`coalesce(${importSourceClaim.canonicalClaimId}, ${importSourceClaim.id})`,
        ),
      )
      .innerJoin(purchase, eq(purchase.id, importSourceOrder.purchaseId))
      .leftJoin(
        vendorAccount,
        and(
          eq(vendorAccount.id, purchase.vendorAccountId),
          notDeleted(vendorAccount),
        ),
      )
      .where(
        and(
          mailSourceIdentity,
          notDeleted(purchase),
          target.vendorId ? eq(purchase.vendorId, target.vendorId) : undefined,
          target.purchaseId ? eq(purchase.id, target.purchaseId) : undefined,
          or(
            isNull(vendorAccount.ledgerPartyId),
            eq(vendorAccount.ledgerPartyId, orderMail.ledgerPartyId),
          ),
        ),
      ),
  );

const reviewedMailScope = (
  db: ReturnType<typeof getDb>,
  target: {
    vendorId?: VendorId;
    purchaseId?: PurchaseId;
  },
) =>
  exists(
    db
      .select({ id: orderMailCandidateDecision.id })
      .from(orderMailEvent)
      .innerJoin(
        orderMailCandidateDecision,
        eq(orderMailCandidateDecision.eventId, orderMailEvent.id),
      )
      .innerJoin(
        purchase,
        eq(purchase.id, orderMailCandidateDecision.purchaseId),
      )
      .leftJoin(
        vendorAccount,
        and(
          eq(vendorAccount.id, purchase.vendorAccountId),
          notDeleted(vendorAccount),
        ),
      )
      .where(
        and(
          eq(orderMailEvent.orderMailId, orderMail.id),
          isNull(orderMailEvent.supersededAt),
          notDeleted(purchase),
          target.vendorId ? eq(purchase.vendorId, target.vendorId) : undefined,
          target.purchaseId ? eq(purchase.id, target.purchaseId) : undefined,
          or(
            isNull(vendorAccount.ledgerPartyId),
            eq(vendorAccount.ledgerPartyId, orderMail.ledgerPartyId),
          ),
        ),
      ),
  );

const candidateReason = (
  event: Pick<typeof orderMailEvent.$inferSelect, "orderId" | "amount"> &
    Pick<typeof orderMail.$inferSelect, "receivedAt">,
  candidate: {
    orderId: string | null;
    statedTotal: number | null;
    date: string | null;
  },
) => {
  if (event.orderId && candidate.orderId === event.orderId)
    return "exact_order_id" as const;
  const withinWindow =
    event.receivedAt !== null &&
    candidate.date !== null &&
    Math.abs(
      plainDateDaysBetween(
        candidate.date,
        householdLocalDate(event.receivedAt),
      ),
    ) <= 45;
  if (!withinWindow) return null;
  if (
    event.amount !== null &&
    candidate.statedTotal !== null &&
    Math.abs(event.amount - candidate.statedTotal) < 0.01
  )
    return "amount_and_date" as const;
  return "nearby_date" as const;
};

const candidateMailDateWindow = (
  mails: ReadonlyArray<Pick<typeof orderMail.$inferSelect, "receivedAt">>,
) => {
  const times = mails.flatMap((mail) =>
    mail.receivedAt ? [mail.receivedAt.getTime()] : [],
  );
  if (!times.length) return undefined;
  return and(
    gte(purchase.date, householdDaysAgo(45, new Date(Math.min(...times)))),
    lte(purchase.date, householdDaysFromNow(45, new Date(Math.max(...times)))),
  );
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
    .where(
      or(
        eq(orderMail.vendorId, vendorId),
        acceptedMailScope(database, { vendorId }),
        reviewedMailScope(database, { vendorId }),
      ),
    );
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
      researchRunId: run.shortcode,
      researchRunStatus: run.status,
      researchSourceStatus: mailboxMessage.status,
      researchChecksum: mailboxMessage.checksum,
      classification: mailboxMessage.classification,
      classificationVersion: mailboxMessage.classificationVersion,
      processingUpdatedAt: mailboxMessage.updatedAt,
      researchStartedAt: run.startedAt,
      researchEndedAt: run.endedAt,
    })
    .from(orderMail)
    .innerJoin(ledgerParty, eq(ledgerParty.id, orderMail.ledgerPartyId))
    .leftJoin(
      mailboxMessage,
      and(
        eq(mailboxMessage.orderMailId, orderMail.id),
        eq(mailboxMessage.ledgerPartyId, orderMail.ledgerPartyId),
        eq(mailboxMessage.mailboxId, orderMail.mailboxId),
        eq(mailboxMessage.messageId, orderMail.messageId),
      ),
    )
    .leftJoin(run, and(eq(run.id, mailboxMessage.runId), notDeleted(run)))
    .where(
      and(
        or(
          eq(orderMail.vendorId, vendorId),
          acceptedMailScope(database, { vendorId }),
          reviewedMailScope(database, { vendorId }),
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
  if (mails.length === 0)
    return purchaseOrderMailOut.parse({ members, items: [] });
  const associations = await database
    .select({
      orderMailId: orderMail.id,
      purchaseId: purchase.shortcode,
      evidenceChecksum: importSourceOrder.checksum,
      acceptedAt: importSourceOrder.createdAt,
    })
    .from(orderMail)
    .innerJoin(importSourceClaim, mailSourceIdentity)
    .innerJoin(
      importSourceOrder,
      eq(
        importSourceOrder.sourceClaimId,
        sql`coalesce(${importSourceClaim.canonicalClaimId}, ${importSourceClaim.id})`,
      ),
    )
    .innerJoin(
      purchase,
      and(
        eq(purchase.id, importSourceOrder.purchaseId),
        notDeleted(purchase),
        eq(purchase.vendorId, vendorId),
      ),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, purchase.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(
      and(
        inArray(
          orderMail.id,
          mails.map((mail) => mail.id),
        ),
        or(
          isNull(vendorAccount.ledgerPartyId),
          eq(vendorAccount.ledgerPartyId, orderMail.ledgerPartyId),
        ),
      ),
    );
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
  const candidateDateWindow = candidateMailDateWindow(mails);
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
          candidateDateWindow,
          decidedPurchaseIds.length
            ? inArray(purchase.id, decidedPurchaseIds)
            : undefined,
        ) ?? sql`false`,
      ),
    );
  const decisionsByPair = new Map(
    decisions.map((decision) => [
      `${decision.eventId}:${decision.purchaseId}`,
      decision,
    ]),
  );
  const eventsByMail = new Map<string, typeof events>();
  for (const event of events) {
    const group = eventsByMail.get(event.orderMailId) ?? [];
    group.push(event);
    eventsByMail.set(event.orderMailId, group);
  }
  return purchaseOrderMailOut.parse({
    members,
    items: mails.map((mail) => ({
      messageId: mail.messageId,
      threadId: mail.threadId,
      sender: mail.sender,
      subject: mail.subject,
      receivedAt: mail.receivedAt?.toISOString() ?? null,
      ledgerPartyId: mail.ledgerPartyShortcode,
      processing:
        mail.classification &&
        mail.classificationVersion &&
        mail.researchSourceStatus &&
        mail.processingUpdatedAt
          ? {
              classification: mail.classification,
              version: mail.classificationVersion,
              status: mail.researchSourceStatus,
              updatedAt: mail.processingUpdatedAt.toISOString(),
            }
          : null,
      researchRun:
        mail.researchRunId &&
        mail.researchRunStatus &&
        mail.researchSourceStatus &&
        mail.researchChecksum
          ? {
              id: mail.researchRunId,
              status: mail.researchRunStatus,
              sourceStatus: mail.researchSourceStatus,
              evidenceChecksum: mail.researchChecksum,
              startedAt: mail.researchStartedAt?.toISOString() ?? null,
              endedAt: mail.researchEndedAt?.toISOString() ?? null,
            }
          : null,
      associations: associations
        .filter((association) => association.orderMailId === mail.id)
        .map(({ purchaseId, evidenceChecksum, acceptedAt }) => ({
          purchaseId,
          evidenceChecksum,
          acceptedAt: acceptedAt.toISOString(),
        })),
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
                decision: decision?.decision ?? null,
                evidenceChecksum: decision?.evidenceChecksum ?? null,
                decisionUpdatedAt: decision?.updatedAt.toISOString() ?? null,
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
  });
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
      shortcode: purchase.shortcode,
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
    .from(orderMail)
    .where(
      or(
        acceptedMailScope(database, { purchaseId: target.id }),
        reviewedMailScope(database, { purchaseId: target.id }),
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
        associations: mail.associations.filter(
          (association) => association.purchaseId === target.shortcode,
        ),
        events: mail.events
          .filter((event) =>
            event.candidates.some(
              (candidate) => candidate.purchaseId === target.shortcode,
            ),
          )
          .map((event) => ({
            ...event,
            candidates: event.candidates.filter(
              (candidate) => candidate.purchaseId === target.shortcode,
            ),
          })),
      }))
      .filter((mail) => mail.events.length > 0 || mail.associations.length > 0),
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
 * can commit between this transaction's read and its
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
    const [source] = await tx
      .select({
        orderMailId: orderMail.id,
        ledgerPartyId: orderMail.ledgerPartyId,
      })
      .from(orderMailEvent)
      .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
      .where(
        and(
          eq(orderMailEvent.id, input.eventId),
          isNull(orderMailEvent.supersededAt),
        ),
      )
      .limit(1);
    if (!source) throw new Error("Order mail event no longer exists");
    await lockOwnedResearchSource(databaseForTransaction(tx), {
      ...source,
      checksum: input.evidenceChecksum,
      actorUserId: actor.userId,
    });
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
        vendorId: purchase.vendorId,
        ledgerPartyId: orderMail.ledgerPartyId,
        purchaseAccountPartyId: vendorAccount.ledgerPartyId,
        vendorName: vendor.name,
      })
      .from(orderMailEvent)
      .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
      .innerJoin(purchase, eq(purchase.id, purchaseId))
      .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
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
