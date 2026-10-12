import {
  emailLinkEvidenceKind,
  emailLinkProposer,
  emailLinkState,
  emailPurchaseLinkState,
  type EmailLinkState,
  type EmailPurchaseLink,
} from "@cubby/schemas/email-fields";
import type {
  EmailId,
  LedgerPartyId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { householdDaySqlText, unwrapDb } from "~/server/repo/database-helpers";
import { emailAcceptedEvidenceSql } from "~/server/repo/email-sql";

/**
 * The record an Emails section or filter is scoped to. A Vendor scope also
 * keeps the Vendor's sender-proof mail with no Purchase match; an account
 * scope is its Vendor's scope narrowed to the account owner's mail.
 */
export type EmailPurchaseScope =
  | { kind: "purchase"; purchaseId: PurchaseId }
  | { kind: "vendor"; vendorId: VendorId }
  | { kind: "vendorAccount"; vendorId: VendorId; ownerId: LedgerPartyId };

const KIND = emailLinkEvidenceKind.enum;
const STATE = emailLinkState.enum;
const PROPOSER = emailLinkProposer.enum;

/** A suggestion must fall within this many household days of the Email. */
const SUGGESTION_WINDOW_DAYS = 45;

/**
 * Every piece of stored evidence relating the correlated `"Email"` row to a
 * Purchase, one row per (order event, Purchase): accepted import sources,
 * reviewed decisions on the current order events, and live suggestions.
 *
 * A suggestion is an undecided event whose order id equals the Purchase's
 * (any Vendor's when the Email has no sender-proof Vendor), or — for the
 * sender-proof Vendor's Purchases when either side lacks an order id — whose
 * amount matches the stated total within a cent inside the window. A nearby
 * date alone is not a suggestion: every order from that Vendor that month
 * would match. Deleted Purchases and another member's account never relate.
 */
const emailPurchaseEvidenceSql = (): SQL => sql`
  SELECT accepted."purchaseId", NULL::uuid AS "eventId", ${KIND.accepted}::text AS "kind",
    false AS "changed", ${PROPOSER.import}::text AS "proposedBy"
  FROM (${emailAcceptedEvidenceSql()}) accepted
  UNION ALL
  SELECT decision."purchaseId", event."id", decision."decision",
    decision."evidenceChecksum" <> original."rawChecksum", decision."proposedBy"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "OrderMailCandidateDecision" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND p."deletedAt" IS NULL
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
  UNION ALL
  SELECT p."id", event."id", ${KIND.suggested}::text, false, ${PROPOSER.heuristic}::text
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "Purchase" p ON p."deletedAt" IS NULL AND (
    p."vendorId" = original."vendorId"
    OR (original."vendorId" IS NULL AND p."orderId" = event."orderId")
  )
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
    AND NOT EXISTS (
      SELECT 1 FROM "OrderMailCandidateDecision" decided
      WHERE decided."eventId" = event."id" AND decided."purchaseId" = p."id"
    )
    AND (
      (event."orderId" IS NOT NULL AND p."orderId" = event."orderId")
      OR (
        p."vendorId" = original."vendorId"
        AND (event."orderId" IS NULL OR p."orderId" IS NULL)
        AND event."amount" IS NOT NULL AND p."statedTotal" IS NOT NULL
        AND abs(event."amount" - p."statedTotal") < 0.01
        AND "Email"."receivedAt" IS NOT NULL AND p."date" IS NOT NULL
        AND abs(p."date" - ${sql.raw(householdDaySqlText(`"Email"."receivedAt"`))}) <= ${SUGGESTION_WINDOW_DAYS}
      )
    )
`;

const inScope = (scope: EmailPurchaseScope, purchaseId: SQL): SQL => {
  switch (scope.kind) {
    case "purchase":
      return sql`${purchaseId} = ${scope.purchaseId}::uuid`;
    case "vendor":
    case "vendorAccount":
      return sql`EXISTS (
        SELECT 1 FROM "Purchase" scoped
        WHERE scoped."id" = ${purchaseId} AND scoped."vendorId" = ${scope.vendorId}::uuid
          AND scoped."deletedAt" IS NULL
      )`;
  }
};

/** The Email's sender-proof Vendor is the scope's Vendor. */
const senderProofSql = (vendorId: VendorId): SQL => sql`EXISTS (
  SELECT 1 FROM "OrderMail" original
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND original."vendorId" = ${vendorId}::uuid
)`;

/** Whether the correlated `"Email"` belongs in the scope's Emails section. */
export const emailInScopeSql = (scope: EmailPurchaseScope): SQL => {
  const related = sql`EXISTS (
    SELECT 1 FROM (${emailPurchaseEvidenceSql()}) evidence
    WHERE ${inScope(scope, sql`evidence."purchaseId"`)}
  )`;
  switch (scope.kind) {
    case "purchase":
      return related;
    case "vendor":
      return sql`(${related} OR ${senderProofSql(scope.vendorId)})`;
    case "vendorAccount":
      return sql`("Email"."ledgerPartyId" = ${scope.ownerId}::uuid AND (${related} OR ${senderProofSql(scope.vendorId)}))`;
  }
};

/**
 * The scope-relative link state of the correlated `"Email"`: its strongest
 * pair inside the scope (everywhere when unscoped), else `none`.
 */
export const emailLinkStateSql = (scope: EmailPurchaseScope | null): SQL =>
  sql`(
    SELECT CASE
      WHEN bool_or(evidence."kind" IN (${KIND.accepted}, ${KIND.linked})) THEN ${STATE.linked}::text
      WHEN bool_or(evidence."kind" = ${KIND.suggested}) THEN ${STATE.suggested}::text
      WHEN bool_or(evidence."kind" = ${KIND.dismissed}) THEN ${STATE.dismissed}::text
      ELSE ${STATE.none}::text
    END
    FROM (${emailPurchaseEvidenceSql()}) evidence
    ${scope ? sql`WHERE ${inScope(scope, sql`evidence."purchaseId"`)}` : sql``}
  )`;

/** Linked first, then suggestions to act on, then nothing, then dismissals. */
export const emailLinkRankSql = (scope: EmailPurchaseScope | null): SQL =>
  sql`CASE ${emailLinkStateSql(scope)}
    WHEN ${STATE.linked}::text THEN 0 WHEN ${STATE.suggested}::text THEN 1
    WHEN ${STATE.none}::text THEN 2 ELSE 3 END`;

const evidenceRow = z.object({
  emailId: z.string(),
  purchaseId: z.string(),
  purchaseShortcode: z.string(),
  vendorId: z.string(),
  eventId: z.string().nullable(),
  kind: emailLinkEvidenceKind,
  changed: z.boolean(),
  proposedBy: emailLinkProposer.nullable(),
});
type EvidenceRow = z.infer<typeof evidenceRow>;

/** The event-level evidence of the named Emails, optionally limited to a scope. */
export async function readEmailPurchaseEvidence(
  db: Database | DrizzleTransaction,
  emailIds: readonly EmailId[],
  scope: EmailPurchaseScope | null,
): Promise<EvidenceRow[]> {
  if (emailIds.length === 0) return [];
  const result = await unwrapDb(db).execute(sql`
    SELECT "Email"."id" AS "emailId", evidence."purchaseId",
      p."shortcode" AS "purchaseShortcode", p."vendorId", evidence."eventId", evidence."kind",
      evidence."changed", evidence."proposedBy"
    FROM "Email"
    CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) evidence
    INNER JOIN "Purchase" p ON p."id" = evidence."purchaseId"
    WHERE "Email"."id" IN (${sql.join(
      emailIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      ${scope ? sql`AND ${inScope(scope, sql`evidence."purchaseId"`)}` : sql``}
  `);
  return z.array(evidenceRow).parse(result.rows);
}

const statePriority = { linked: 0, suggested: 1, dismissed: 2 } as const;

/** Folds one Email's event-level evidence into its pairs, strongest first. */
export function foldPurchaseLinks(
  rows: readonly EvidenceRow[],
): EmailPurchaseLink[] {
  const byPurchase = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const group = byPurchase.get(row.purchaseId) ?? [];
    group.push(row);
    byPurchase.set(row.purchaseId, group);
  }
  const links: EmailPurchaseLink[] = [];
  for (const [purchaseId, pair] of byPurchase) {
    const linking = pair.filter(
      (row) => row.kind === "accepted" || row.kind === "linked",
    );
    const state = emailPurchaseLinkState.parse(
      linking.length > 0
        ? "linked"
        : pair.some((row) => row.kind === "suggested")
          ? "suggested"
          : "dismissed",
    );
    const deciding =
      state === "linked" ? linking : pair.filter((row) => row.kind === state);
    // A Link here demotes another Purchase's link on the events it touches.
    const touched = new Set(
      state === "linked"
        ? []
        : pair.flatMap((row) => (row.eventId ? [row.eventId] : [])),
    );
    const replaces = [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.kind === "linked" &&
              row.purchaseId !== purchaseId &&
              row.eventId !== null &&
              touched.has(row.eventId),
          )
          .map((row) => row.purchaseShortcode),
      ),
    ].sort();
    links.push({
      purchaseId: parseShortcodeFor("purchase", pair[0]!.purchaseShortcode),
      state,
      accepted: pair.some((row) => row.kind === "accepted"),
      changedSinceReview: deciding.some((row) => row.changed),
      replacesPurchaseIds: replaces.map((code) =>
        parseShortcodeFor("purchase", code),
      ),
      proposedBy: deciding.find((row) => row.proposedBy)?.proposedBy ?? null,
    });
  }
  return links.sort(
    (left, right) =>
      statePriority[left.state] - statePriority[right.state] ||
      left.purchaseId.localeCompare(right.purchaseId),
  );
}

/** The strongest pair state, or `none` when the Email has no pair in scope. */
export const strongestLinkState = (
  links: readonly EmailPurchaseLink[],
): EmailLinkState => emailLinkState.parse(links[0]?.state ?? "none");

const pairInScope = (
  scope: EmailPurchaseScope | null,
  rows: readonly EvidenceRow[],
) => {
  if (scope === null) return () => true;
  const vendorOf = new Map(rows.map((row) => [row.purchaseShortcode, row]));
  return (link: EmailPurchaseLink) => {
    const row = vendorOf.get(link.purchaseId);
    if (!row) return false;
    return scope.kind === "purchase"
      ? row.purchaseId === scope.purchaseId
      : row.vendorId === scope.vendorId;
  };
};

/**
 * Pairs for a page of Emails, keyed by Email id. Folds every pair of the
 * Email first — a Link's replaced Purchase may sit outside the scope — then
 * keeps the pairs inside it.
 */
export async function readEmailPurchaseLinks(
  db: Database | DrizzleTransaction,
  emailIds: readonly EmailId[],
  scope: EmailPurchaseScope | null,
): Promise<Map<string, EmailPurchaseLink[]>> {
  const rows = await readEmailPurchaseEvidence(db, emailIds, null);
  const keep = pairInScope(scope, rows);
  const byEmail = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const group = byEmail.get(row.emailId) ?? [];
    group.push(row);
    byEmail.set(row.emailId, group);
  }
  return new Map(
    [...byEmail].map(([emailId, group]) => [
      emailId,
      foldPurchaseLinks(group).filter(keep),
    ]),
  );
}
