import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { sql } from "drizzle-orm";

import { purchaseAssociatedEmailsSql } from "~/server/domains/email/repo/email-sql";
import { purchaseSettlementConflictSql } from "~/server/domains/financial-transaction/repo/settlement-conflicts";

/** Correlated to Purchase; inherited attribution is never persisted. */
export const purchasePurchaserSql = sql<LedgerPartyShortcode | null>`(
  WITH payment_accounts AS (
    SELECT DISTINCT fa.id, fa."primaryCardholderId", fa."authorizedUsers"
    FROM "FinancialTransactionAllocation" allocation
    JOIN "FinancialTransaction" ft ON ft.id = allocation."transactionId"
      AND ft."deletedAt" IS NULL AND ft.status <> ${financialTransactionStatus.enum.void}
      AND ft.kind IN (${sql.join(
        purchaseSettlementKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
    JOIN "FinancialAccount" fa ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
    WHERE allocation."purchaseId" = "Purchase".id AND allocation."deletedAt" IS NULL
      AND allocation.amount > 0
  ), sole_users AS (
    SELECT party.shortcode
    FROM payment_accounts account
    JOIN "LedgerParty" party ON party.id = account."primaryCardholderId"
      AND party."deletedAt" IS NULL AND party.kind = ${ledgerPartyKind.enum.member}
    WHERE "Purchase".date IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(account."authorizedUsers") membership
      WHERE (membership->>'validFrom' IS NULL OR (membership->>'validFrom')::date <= "Purchase".date)
        AND (membership->>'validTo' IS NULL OR "Purchase".date <= (membership->>'validTo')::date)
    )
  ), evidence_parties AS (
    SELECT party.shortcode
    FROM "VendorAccount" account
    JOIN "LedgerParty" party ON party.id = account."ledgerPartyId"
      AND party."deletedAt" IS NULL AND party.kind = ${ledgerPartyKind.enum.member}
    WHERE account.id = "Purchase"."vendorAccountId" AND account."deletedAt" IS NULL
    UNION
    SELECT party.shortcode
    FROM (${purchaseAssociatedEmailsSql(sql`"Purchase".id`, "ignore")}) "Email"
    JOIN "LedgerParty" party ON party.id = "Email"."ledgerPartyId"
      AND party."deletedAt" IS NULL AND party.kind = ${ledgerPartyKind.enum.member}
  )
  SELECT CASE
    WHEN "Purchase"."purchaserOverrideId" IS NOT NULL THEN
      (SELECT shortcode FROM "LedgerParty" WHERE id = "Purchase"."purchaserOverrideId" AND "deletedAt" IS NULL)
    -- A settlement_party_conflict is a disagreement between the paying
    -- account and the order's member, not attribution for either.
    WHEN ${purchaseSettlementConflictSql("party", '"Purchase"')} THEN NULL
    WHEN (SELECT count(*) FROM payment_accounts) > 0
      AND (SELECT count(*) FROM payment_accounts) = (SELECT count(*) FROM sole_users)
      AND (SELECT count(DISTINCT shortcode) FROM sole_users) = 1
      THEN (SELECT min(shortcode) FROM sole_users)
    WHEN (SELECT count(*) FROM evidence_parties) = 1 THEN (SELECT min(shortcode) FROM evidence_parties)
    ELSE NULL END
)`;

/**
 * `("id", "value")` for every Purchase with an effective purchaser, as
 * `purchasePurchaserSql` displays it. Each branch reads one source the
 * resolver can decide by — the override, cards the party holds, its Vendor
 * Accounts, its mailbox's accepted import sources and reviewed Email links —
 * from the party's side through indexed edges, so a filter's
 * `"value" IN (…)` reaches the party lookup and only that party's candidates
 * pay for the resolver, which confirms each one. The branches are a superset
 * of the resolver's decisions, so the set agrees with the column row for row.
 */
export const purchasePurchaserSetSql = sql`
  SELECT "Purchase".id, candidate.value
  FROM (
    SELECT purchase.id, party.shortcode AS value
    FROM "LedgerParty" party
    JOIN "Purchase" purchase ON purchase."purchaserOverrideId" = party.id
    UNION
    SELECT purchase.id, party.shortcode
    FROM "LedgerParty" party
    JOIN "VendorAccount" account ON account."ledgerPartyId" = party.id
    JOIN "Purchase" purchase ON purchase."vendorAccountId" = account.id
    UNION
    SELECT allocation."purchaseId", party.shortcode
    FROM "LedgerParty" party
    JOIN "FinancialAccount" card ON card."primaryCardholderId" = party.id
    JOIN "FinancialTransaction" ft ON ft."accountId" = card.id
    JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId" = ft.id
    UNION
    -- An accepted source whose claim family holds one of the party's mail claims.
    SELECT accepted."purchaseId", party.shortcode
    FROM "LedgerParty" party
    JOIN "ImportSourceClaim" claim ON claim."ledgerPartyId" = party.id
      AND claim.kind IN (${importSourceKind.enum.mail_message}, ${importSourceKind.enum.mail_attachment})
    JOIN "ImportSourceOrder" accepted
      ON accepted."sourceClaimId" = coalesce(claim."canonicalClaimId", claim.id)
    UNION
    SELECT accepted."purchaseId", party.shortcode
    FROM "LedgerParty" party
    JOIN "ImportSourceClaim" claim ON claim."ledgerPartyId" = party.id
      AND claim.kind IN (${importSourceKind.enum.mail_message}, ${importSourceKind.enum.mail_attachment})
    JOIN "ImportSourceClaim" family
      ON family."canonicalClaimId" = coalesce(claim."canonicalClaimId", claim.id)
    JOIN "ImportSourceOrder" accepted ON accepted."sourceClaimId" = family.id
    UNION
    SELECT decision."purchaseId", party.shortcode
    FROM "LedgerParty" party
    JOIN "Email" email ON email."ledgerPartyId" = party.id
    JOIN "OrderMailEvent" event ON event."orderMailId" = email."orderMailId"
    JOIN "AssessmentEmailLink" decision ON decision."eventId" = event.id
  ) candidate
  JOIN "Purchase" ON "Purchase".id = candidate.id
  -- COALESCE keeps the rows "=" keeps, but escapes the planner's 0.5%
  -- equality guess, which turned the list's IN into a nested-loop scan.
  WHERE coalesce(${purchasePurchaserSql} = candidate.value, false)
`;
