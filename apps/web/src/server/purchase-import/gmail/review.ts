import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  userId,
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
  importSourceOrder,
  ledgerParty,
  email as emailTable,
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
import { emailAcceptedEvidenceSql } from "~/server/repo/email-sql";
import {
  retainedMailJoin,
  retainedMailProjection,
  type RetainedMail,
} from "~/server/repo/retained-mail";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { assertMailSourceIdentityReady } from "../mail-source-identity";
import { ensureMailVendorAccount } from "./mail-account";

/** The member's own retained Email, locked at the checksum they reviewed. */
async function lockOwnedMailSource(
  db: Database,
  input: {
    orderMailId: string;
    checksum: string;
    ledgerPartyId: string;
    actorUserId: string;
  },
) {
  const [owned] = await getDb(db)
    .select({ source: retainedMailProjection })
    .from(orderMail)
    .innerJoin(emailTable, retainedMailJoin)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, orderMail.ledgerPartyId),
        eq(ledgerParty.userId, userId.parse(input.actorUserId)),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(orderMail.id, input.orderMailId),
        eq(
          orderMail.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(orderMail.rawChecksum, input.checksum),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
      ),
    )
    .for("update", { of: orderMail });
  if (!owned) throw new Error("Order mail ownership or checksum changed.");
  await assertMailSourceIdentityReady(getDb(db), owned.source);
  return owned.source;
}

/** Accepted source families share the Email repository's ownership policy. */
const acceptedMailScope = (
  db: ReturnType<typeof getDb>,
  target: {
    vendorId?: VendorId;
    purchaseId?: PurchaseId;
  },
) =>
  exists(
    db
      .select({ id: purchase.id })
      .from(purchase)
      .where(
        and(
          sql`${purchase.id} IN (
            SELECT accepted_evidence."purchaseId"
            FROM (${emailAcceptedEvidenceSql()}) accepted_evidence
          )`,
          notDeleted(purchase),
          target.vendorId ? eq(purchase.vendorId, target.vendorId) : undefined,
          target.purchaseId ? eq(purchase.id, target.purchaseId) : undefined,
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
    Pick<RetainedMail, "receivedAt">,
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
  mails: ReadonlyArray<Pick<RetainedMail, "receivedAt">>,
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
    .innerJoin(emailTable, retainedMailJoin)
    .innerJoin(ledgerParty, eq(ledgerParty.id, orderMail.ledgerPartyId))
    .where(
      and(
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
        or(
          eq(orderMail.vendorId, vendorId),
          acceptedMailScope(database, { vendorId }),
          reviewedMailScope(database, { vendorId }),
        ),
      ),
    );
  const mails = await database
    .select({
      id: orderMail.id,
      ledgerPartyId: orderMail.ledgerPartyId,
      ledgerPartyShortcode: ledgerParty.shortcode,
      messageId: emailTable.messageId,
      threadId: emailTable.threadId,
      sender: emailTable.sender,
      subject: emailTable.subject,
      receivedAt: emailTable.receivedAt,
      rawChecksum: orderMail.rawChecksum,
      researchRunId: run.shortcode,
      researchRunStatus: run.status,
      researchSourceStatus: emailTable.status,
      researchChecksum: emailTable.checksum,
      classification: emailTable.classification,
      classificationVersion: emailTable.classificationVersion,
      processingUpdatedAt: emailTable.updatedAt,
      researchStartedAt: run.startedAt,
      researchEndedAt: run.endedAt,
    })
    .from(orderMail)
    .innerJoin(ledgerParty, eq(ledgerParty.id, orderMail.ledgerPartyId))
    .innerJoin(emailTable, retainedMailJoin)
    .leftJoin(
      run,
      and(
        eq(run.id, emailTable.runId),
        eq(emailTable.orderMailId, orderMail.id),
        notDeleted(run),
      ),
    )
    .where(
      and(
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
        or(
          eq(orderMail.vendorId, vendorId),
          acceptedMailScope(database, { vendorId }),
          reviewedMailScope(database, { vendorId }),
        ),
        ledgerPartyId ? eq(orderMail.ledgerPartyId, ledgerPartyId) : undefined,
        options.messageIds
          ? inArray(emailTable.messageId, options.messageIds)
          : undefined,
        options.orderMailIds
          ? inArray(orderMail.id, options.orderMailIds)
          : undefined,
      ),
    )
    .orderBy(desc(emailTable.receivedAt))
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
    .selectDistinct({
      orderMailId: orderMail.id,
      purchaseId: purchase.shortcode,
      evidenceChecksum: sql`accepted_evidence."evidenceChecksum"`.mapWith(
        importSourceOrder.checksum,
      ),
      acceptedAt: sql`accepted_evidence."acceptedAt"`.mapWith(
        importSourceOrder.createdAt,
      ),
    })
    .from(orderMail)
    .innerJoin(emailTable, retainedMailJoin)
    .innerJoin(
      sql`LATERAL (${emailAcceptedEvidenceSql()}) accepted_evidence`,
      sql`true`,
    )
    .innerJoin(
      purchase,
      and(
        eq(purchase.id, sql`accepted_evidence."purchaseId"`),
        notDeleted(purchase),
        eq(purchase.vendorId, vendorId),
      ),
    )
    .where(
      inArray(
        orderMail.id,
        mails.map((mail) => mail.id),
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
    .innerJoin(emailTable, retainedMailJoin)
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
    await lockOwnedMailSource(databaseForTransaction(tx), {
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
