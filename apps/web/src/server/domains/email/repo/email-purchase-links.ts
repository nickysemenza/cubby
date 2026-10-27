import {
  emailLinkEvidenceKind,
  emailLinkProposer,
  emailLinkState,
  emailPurchaseLinkLabel,
  emailPurchaseLinkState,
  type EmailLinkState,
  type EmailPurchaseLink,
} from "@cubby/schemas/email-fields";
import {
  emailPurchaseFact,
  emailRelationshipResult,
} from "@cubby/schemas/email-relationship-facts";
import type {
  EmailId,
  LedgerPartyId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  purchase,
  vendorAccount,
} from "~/server/db/generated/entity-table-definitions.gen";
import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySqlText, uuidArrayParam } from "~/server/db/helpers/query";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { emailAcceptedEvidenceSql } from "~/server/domains/email/repo/email-sql";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import type { PageStoredMeta } from "~/server/generic/derived/repo/read-context";

/**
 * The record an Emails section or filter is scoped to. A Vendor scope also
 * keeps the Vendor's sender-proof mail with no Purchase match; an account
 * scope is its Vendor's scope narrowed to the account owner's mail.
 */
export type EmailPurchaseScope =
  | { kind: "purchase"; purchaseId: PurchaseId }
  | { kind: "vendor"; vendorId: VendorId }
  | { kind: "vendorAccount"; vendorId: VendorId; ownerId: LedgerPartyId };

const livePurchase = alias(purchase, "p");
const liveAccount = alias(vendorAccount, "account");

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
export const emailPurchaseEvidenceSql = (
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
  SELECT accepted."purchaseId", NULL::uuid AS "eventId", ${KIND.accepted}::text AS "kind",
    accepted."changed", ${PROPOSER.import}::text AS "proposedBy"
  FROM (${emailAcceptedEvidenceSql(false, accountOwnerScope)}) accepted
  UNION ALL
  SELECT decision."purchaseId", event."id", decision."decision",
    decision."evidenceChecksum" <> original."rawChecksum", decision."proposedBy"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "AssessmentEmailLink" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND ${notDeleted(livePurchase)}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND ${notDeleted(liveAccount)}
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL
    AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")` : sql`true`}
  UNION ALL
  SELECT p."id", event."id", ${KIND.suggested}::text, false, ${PROPOSER.heuristic}::text
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  -- Exact-order and amount/date candidates are disjoint; each gets its own lookup.
  INNER JOIN LATERAL (
    SELECT p."id", p."vendorAccountId", p."deletedAt" FROM "Purchase" p
    WHERE p."orderId" = event."orderId"
      AND (original."vendorId" IS NULL OR p."vendorId" = original."vendorId")
    UNION ALL
    SELECT p."id", p."vendorAccountId", p."deletedAt" FROM "Purchase" p
    WHERE p."vendorId" = original."vendorId"
        AND (event."orderId" IS NULL OR p."orderId" IS NULL)
        AND event."amount" IS NOT NULL AND p."statedTotal" IS NOT NULL
        AND abs(event."amount" - p."statedTotal") < 0.01
        AND "Email"."receivedAt" IS NOT NULL AND p."date" IS NOT NULL
        AND p."date" BETWEEN
          ${sql.raw(householdDaySqlText(`"Email"."receivedAt"`))} - ${SUGGESTION_WINDOW_DAYS}::integer
          AND ${sql.raw(householdDaySqlText(`"Email"."receivedAt"`))} + ${SUGGESTION_WINDOW_DAYS}::integer
  ) p ON ${notDeleted(livePurchase)}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND ${notDeleted(liveAccount)}
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL
    AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")` : sql`true`}
    AND NOT EXISTS (
      SELECT 1 FROM "AssessmentEmailLink" decided
      WHERE decided."eventId" = event."id" AND decided."purchaseId" = p."id"
    )
`;

const inScope = (scope: EmailPurchaseScope, purchaseId: SQL): SQL => {
  switch (scope.kind) {
    case "purchase":
      return sql`${purchaseId} = ${scope.purchaseId}::uuid`;
    case "vendor":
    case "vendorAccount":
      return sql`EXISTS (
        SELECT 1 FROM ${purchase} scoped
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
  const matches = sql`EXISTS (
    SELECT 1 FROM (${cachedEmailPurchaseEvidenceSql()}) evidence
    WHERE ${inScope(scope, sql`evidence."purchaseId"`)}
  )`;
  const related = sql`CASE WHEN ${emailRelationshipResultExistsSql}
    THEN ${matches} ELSE NULL::boolean END`;
  switch (scope.kind) {
    case "purchase":
      // Eligibility is authoritative even while the candidate facts are missing.
      // Do not count another account owner's mail as unresolved in this scope.
      return sql`CASE WHEN ${emailRelationshipResultExistsSql} THEN ${matches}
        WHEN NOT EXISTS (
          SELECT 1 FROM ${purchase} p
          LEFT JOIN ${vendorAccount} account ON account.id = p."vendorAccountId" AND account."deletedAt" IS NULL
          WHERE p.id = ${scope.purchaseId}::uuid AND p."deletedAt" IS NULL
            AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
        ) THEN false ELSE NULL::boolean END`;
    case "vendor":
      return sql`(${related} OR ${senderProofSql(scope.vendorId)})`;
    case "vendorAccount":
      return sql`("Email"."ledgerPartyId" = ${scope.ownerId}::uuid AND (${related} OR ${senderProofSql(scope.vendorId)}))`;
  }
};

/** A missing computation is not a successful no-match result. */
const emailRelationshipResultExistsSql = sql`EXISTS (
  SELECT 1 FROM "DerivedValue" v WHERE v."entityId" = "Email".id AND v.key = 'relationshipFacts'
    AND v."decidedBy"#>>'{outcome,kind}' = 'value' AND jsonb_typeof(v.value->'facts') = 'array'
)`;

/** Fixed typed facts, with current account-owner eligibility kept separate. */
const cachedEmailPurchaseEvidenceSql = (): SQL => sql`
  SELECT fact."purchaseId", fact."eventId", fact.kind, fact.changed, fact."proposedBy"
  FROM "DerivedValue" v
  CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(v.value->'facts') = 'array'
    THEN v.value->'facts' ELSE '[]'::jsonb END)
    AS fact("purchaseId" uuid, "eventId" uuid, kind text, changed boolean, "proposedBy" text)
  JOIN "Purchase" p ON p.id = fact."purchaseId" AND ${notDeleted(livePurchase)}
  LEFT JOIN "VendorAccount" account ON account.id = p."vendorAccountId" AND ${notDeleted(liveAccount)}
  WHERE v."entityId" = "Email".id AND v.key = 'relationshipFacts'
    AND v."decidedBy"#>>'{outcome,kind}' = 'value'
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
`;

/**
 * The scope-relative link state of the correlated `"Email"`: its strongest
 * pair inside the scope (everywhere when unscoped), else `none`.
 */
export const emailLinkStateSql = (scope: EmailPurchaseScope | null): SQL =>
  sql`CASE WHEN ${emailRelationshipResultExistsSql} THEN (
    SELECT CASE
      WHEN bool_or(evidence."kind" IN (${KIND.accepted}, ${KIND.linked})) THEN ${STATE.linked}::text
      WHEN bool_or(evidence."kind" = ${KIND.suggested}) THEN ${STATE.suggested}::text
      WHEN bool_or(evidence."kind" = ${KIND.dismissed}) THEN ${STATE.dismissed}::text
      ELSE ${STATE.none}::text
    END
    FROM (${cachedEmailPurchaseEvidenceSql()}) evidence
    ${scope ? sql`WHERE ${inScope(scope, sql`evidence."purchaseId"`)}` : sql``}
  ) ELSE NULL::text END`;

/** Linked first, then suggestions to act on, then nothing, then dismissals. */
export const emailLinkRankSql = (scope: EmailPurchaseScope | null): SQL =>
  sql`CASE ${emailLinkStateSql(scope)}
    WHEN ${STATE.linked}::text THEN 0 WHEN ${STATE.suggested}::text THEN 1
    WHEN ${STATE.none}::text THEN 2 WHEN ${STATE.dismissed}::text THEN 3 ELSE NULL END`;

/** Ordinary linked/import-state reads reuse published evidence; command guards stay live. */
export const cachedEmailLinkedSql = (): SQL<
  boolean | null
> => sql`CASE WHEN ${emailRelationshipResultExistsSql} THEN EXISTS (
  SELECT 1 FROM (${cachedEmailPurchaseEvidenceSql()}) evidence WHERE evidence.kind IN (${KIND.accepted}, ${KIND.linked})
) ELSE NULL::boolean END`;

const evidenceRow = emailPurchaseFact.extend({ emailId: z.string() });
type EvidenceRow = z.infer<typeof evidenceRow>;

/** The event-level evidence of the named Emails, optionally limited to a scope. */
export async function readEmailPurchaseEvidence(
  db: Database | DrizzleTransaction,
  emailIds: readonly EmailId[],
  scope: EmailPurchaseScope | null,
  accountOwnerScope: "respect" | "ignore" = "respect",
): Promise<EvidenceRow[]> {
  if (emailIds.length === 0) return [];
  const result = await unwrapDb(db).execute(sql`
    SELECT "Email"."id" AS "emailId", evidence."purchaseId",
      p."shortcode" AS "purchaseShortcode", p."vendorId", evidence."eventId", evidence."kind",
      evidence."changed", evidence."proposedBy"
    FROM "Email"
    CROSS JOIN LATERAL (${emailPurchaseEvidenceSql(accountOwnerScope)}) evidence
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
    const purchaseCode = parseShortcodeFor(
      "purchase",
      pair[0]!.purchaseShortcode,
    );
    links.push({
      purchaseId: purchaseCode,
      state,
      label: emailPurchaseLinkLabel(purchaseCode, state),
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

const currentPurchase = z.object({
  id: z.string(),
  vendorId: z.string(),
  ownerId: z.string().nullable(),
});

/** Current cheap eligibility gates do not rerun candidate discovery. */
export async function loadRelationshipPurchaseGates(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (ids.length === 0)
    return new Map<string, z.output<typeof currentPurchase>>();
  const result = await unwrapDb(db).execute(sql`
    SELECT p.id, p."vendorId", account."ledgerPartyId" AS "ownerId" FROM "Purchase" p
    LEFT JOIN "VendorAccount" account ON account.id = p."vendorAccountId" AND ${notDeleted(liveAccount)}
    WHERE p.id = ANY(${uuidArrayParam(ids)}) AND ${notDeleted(livePurchase)}`);
  return new Map(
    z
      .array(currentPurchase)
      .parse(result.rows)
      .map((row) => [row.id, row]),
  );
}

export function foldScopedEmailPurchaseFacts({
  facts,
  emailId,
  ownerId,
  purchases,
  scope,
}: {
  facts: readonly z.output<typeof emailPurchaseFact>[];
  emailId: string;
  ownerId: string;
  purchases: ReadonlyMap<string, z.output<typeof currentPurchase>>;
  scope: EmailPurchaseScope | null;
}): EmailPurchaseLink[] {
  const rows = facts.flatMap((fact) => {
    const purchase = purchases.get(fact.purchaseId);
    return purchase &&
      (purchase.ownerId === null || purchase.ownerId === ownerId)
      ? [{ ...fact, vendorId: purchase.vendorId, emailId }]
      : [];
  });
  const keep = pairInScope(scope, rows);
  return scope?.kind === "vendorAccount" && scope.ownerId !== ownerId
    ? []
    : foldPurchaseLinks(rows).filter(keep);
}

/** Page hydration folds the same cached facts its SQL predicates use. */
export async function readCachedEmailPurchaseLinks(
  db: Database | DrizzleTransaction,
  emails: readonly { id: string; ledgerPartyId: string }[],
  scope: EmailPurchaseScope | null,
  started?: Promise<PageStoredMeta>,
): Promise<
  Map<
    string,
    {
      links: EmailPurchaseLink[];
      linked: boolean;
      accepted: boolean;
      computedAt: string;
    }
  >
> {
  const stored = started
    ? await started
    : await loadStoredDerived(
        db,
        "email",
        emails.map((row) => row.id),
        ["relationshipFacts"],
      );
  const results = emails.flatMap((email) => {
    const read = stored.get(email.id)?.get("relationshipFacts");
    const parsed = emailRelationshipResult.safeParse(read?.value);
    return read?.resultExists && read.computedAt && parsed.success
      ? [{ email, read, result: parsed.data, computedAt: read.computedAt }]
      : [];
  });
  const purchases = await loadRelationshipPurchaseGates(db, [
    ...new Set(
      results.flatMap(({ result }) =>
        result.facts.map((fact) => fact.purchaseId),
      ),
    ),
  ]);
  return new Map(
    results.map(({ email, result, computedAt }) => {
      const globalLinks = foldScopedEmailPurchaseFacts({
        facts: result.facts,
        emailId: email.id,
        ownerId: email.ledgerPartyId,
        purchases,
        scope: null,
      });
      return [
        email.id,
        {
          links: scope
            ? foldScopedEmailPurchaseFacts({
                facts: result.facts,
                emailId: email.id,
                ownerId: email.ledgerPartyId,
                purchases,
                scope,
              })
            : globalLinks,
          linked: globalLinks.some((link) => link.state === "linked"),
          accepted: globalLinks.some((link) => link.accepted),
          computedAt,
        },
      ];
    }),
  );
}
