import type { ActorContext } from "@cubby/schemas/context";
import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { email, orderMail, orderMailEvent, purchase } from "~/server/db/schema";
import {
  emailPurchaseEvidenceSql,
  foldPurchaseLinks,
  readEmailPurchaseEvidence,
} from "~/server/domains/email/repo/email-purchase-links";
import { decideEmailPurchase } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const retainedChoice = z.object({
  originalId: z.uuid(),
  eventId: z.uuid(),
  expectedChecksum: z.string(),
});
const endpointPair = z.object({
  emailCode: z.string(),
  purchaseCode: z.string(),
});

/** Retrieval reuses the retained event policy, including account ownership. */
export async function retrieveEmailConnectionCandidates(
  db: Database,
  source: EntityRef,
): Promise<ConnectionCandidate[]> {
  if (source.entityKind !== "email" && source.entityKind !== "purchase")
    return [];
  const id = await resolveOrThrow(db, source.entityKind, source.entityId);
  const rows = await getDb(db).execute(sql`
    SELECT DISTINCT "Email"."shortcode" AS "emailCode", p."shortcode" AS "purchaseCode"
    FROM "Email"
    CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) evidence
    INNER JOIN "Purchase" p ON p."id" = evidence."purchaseId" AND p."deletedAt" IS NULL
    WHERE "Email"."deletedAt" IS NULL AND evidence."kind" = ${emailLinkEvidenceKind.enum.suggested}
      AND ${source.entityKind === "email" ? sql`"Email"."id"=${id}::uuid` : sql`p."id"=${id}::uuid`}
    ORDER BY "emailCode", "purchaseCode" LIMIT 20
  `);
  const candidates: ConnectionCandidate[] = [];
  for (const pair of z.array(endpointPair).parse(rows.rows)) {
    const candidate: ConnectionCandidate = {
      relation: "email-purchase",
      source: { entityKind: "email", entityId: pair.emailCode },
      target: { entityKind: "purchase", entityId: pair.purchaseCode },
      label: "Review retained Email purchase link",
      evidence: {
        reasons: [
          "Retained order event matches the existing Email purchase evidence policy",
        ],
        contradictions: [],
        unknowns: [
          "Confirm this event belongs to the Purchase; matching evidence alone grants no import authority",
          "Acceptance is restricted to the Email owner; agents use mail.resolve",
        ],
      },
    };
    const basis = await captureEmailConnectionBasis(db, candidate);
    const dependencies = basis.dependencies;
    if (dependencies) {
      const replacements = [
        ...new Set(
          dependencies.evidence
            .filter(
              (row) =>
                row.kind === "linked" &&
                row.eventId === dependencies.eventId &&
                row.purchaseShortcode !== pair.purchaseCode,
            )
            .map(
              (row) =>
                `Acceptance replaces this event's reviewed link to ${row.purchaseShortcode}`,
            ),
        ),
      ];
      if (replacements.length) {
        candidate.label = "Replace reviewed Email purchase link";
        candidate.evidence.reasons.push(...replacements);
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** Purchase → original → Email precedes the event writer's advisory/row locks.
 * Never let generic endpoint locking take Email ahead of its retained original.
 */
export async function captureEmailConnectionBasis(
  db: Database,
  candidate: ConnectionCandidate,
  lock = false,
) {
  const purchaseId = await resolveOrThrow(
    db,
    "purchase",
    candidate.target.entityId,
  );
  const emailId = await resolveOrThrow(db, "email", candidate.source.entityId);
  const targetQuery = getDb(db)
    .select({
      id: purchase.id,
      orderId: purchase.orderId,
      vendorId: purchase.vendorId,
      vendorAccountId: purchase.vendorAccountId,
      date: purchase.date,
      statedTotal: purchase.statedTotal,
    })
    .from(purchase)
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .limit(1);
  const [target] = lock ? await targetQuery.for("update") : await targetQuery;
  const emailQuery = () =>
    getDb(db)
      .select({
        id: email.id,
        ledgerPartyId: email.ledgerPartyId,
        originalId: email.orderMailId,
        checksum: email.checksum,
        receivedAt: email.receivedAt,
      })
      .from(email)
      .where(and(eq(email.id, emailId), notDeleted(email)))
      .limit(1);
  const [before] = await emailQuery();
  if (!target || !before)
    throw new Error("Connection Email or Purchase no longer exists");
  if (!before.originalId) return { source: before, target, dependencies: null };
  const originalQuery = getDb(db)
    .select({
      id: orderMail.id,
      ledgerPartyId: orderMail.ledgerPartyId,
      vendorId: orderMail.vendorId,
      rawChecksum: orderMail.rawChecksum,
    })
    .from(orderMail)
    .where(eq(orderMail.id, before.originalId))
    .limit(1);
  const [original] = lock
    ? await originalQuery.for("update")
    : await originalQuery;
  const [source] = lock ? await emailQuery().for("update") : await emailQuery();
  if (!source) throw new Error("Connection Email no longer exists");
  if (
    !original ||
    source.originalId !== original.id ||
    original.ledgerPartyId !== source.ledgerPartyId ||
    original.rawChecksum !== source.checksum
  )
    return { source, target, dependencies: null };
  const readEvidence = () =>
    readEmailPurchaseEvidence(db, [parseEntityId("email", emailId)], null);
  let evidence = await readEvidence();
  const pair = foldPurchaseLinks(evidence).find(
    (row) => row.purchaseId === candidate.target.entityId,
  );
  // Accepted import sources are reconciled by the import workflow. Never offer
  // a competing link on an original already retained as accepted evidence.
  if (
    evidence.some((row) => row.kind === "accepted") ||
    pair?.state !== "suggested"
  )
    return { source, target, dependencies: null };
  const chosen = evidence
    .filter(
      (row) =>
        row.purchaseId === purchaseId &&
        row.kind === "suggested" &&
        row.eventId !== null,
    )
    .sort((a, b) => (a.eventId ?? "").localeCompare(b.eventId ?? ""))[0];
  if (!chosen?.eventId) return { source, target, dependencies: null };
  if (lock)
    await getDb(db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`email-link-event:${chosen.eventId}`},0))`,
    );
  const eventQuery = getDb(db)
    .select({
      id: orderMailEvent.id,
      originalId: orderMailEvent.orderMailId,
      event: orderMailEvent.event,
      orderId: orderMailEvent.orderId,
      amount: orderMailEvent.amount,
      sourceKey: orderMailEvent.sourceKey,
    })
    .from(orderMailEvent)
    .where(
      and(
        eq(orderMailEvent.id, chosen.eventId),
        eq(orderMailEvent.orderMailId, original.id),
        isNull(orderMailEvent.supersededAt),
      ),
    )
    .limit(1);
  const [event] = lock ? await eventQuery.for("update") : await eventQuery;
  if (!event) return { source, target, dependencies: null };
  if (lock) evidence = await readEvidence();
  const current = foldPurchaseLinks(evidence).find(
    (row) => row.purchaseId === candidate.target.entityId,
  );
  if (
    evidence.some((row) => row.kind === "accepted") ||
    current?.state !== "suggested" ||
    !evidence.some(
      (row) =>
        row.eventId === event.id &&
        row.purchaseId === purchaseId &&
        row.kind === "suggested",
    )
  )
    return { source, target, dependencies: null };
  return {
    source,
    target,
    dependencies: {
      originalId: original.id,
      eventId: event.id,
      expectedChecksum: source.checksum,
      original,
      event,
      evidence: evidence.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    },
  };
}

/** The existing member writer owns link authority, ownership and checksum fences. */
export async function applyEmailConnection(
  db: Database,
  candidate: ConnectionCandidate,
  basis: unknown,
  actor: ActorContext,
) {
  const { dependencies } = z
    .object({ dependencies: retainedChoice })
    .parse(basis);
  await decideEmailPurchase(
    db,
    {
      id: parseShortcodeFor("email", candidate.source.entityId),
      purchaseId: parseShortcodeFor("purchase", candidate.target.entityId),
      expectedChecksum: dependencies.expectedChecksum,
      decision: "linked",
    },
    actor,
    { eventId: dependencies.eventId, originalId: dependencies.originalId },
  );
}
