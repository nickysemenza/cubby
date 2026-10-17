import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { sql } from "drizzle-orm";

import { purchaseAssociatedEmailsSql } from "~/server/domains/email/repo/email-sql";
import { purchaseSettlementConflictRawSql } from "~/server/domains/financial-transaction/repo/settlement-conflicts";

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
    WHEN (SELECT count(*) FROM payment_accounts) > 0
      AND (SELECT count(*) FROM payment_accounts) = (SELECT count(*) FROM sole_users)
      AND (SELECT count(DISTINCT shortcode) FROM sole_users) = 1
      -- A settlement_party_conflict is a disagreement, not attribution.
      THEN CASE WHEN ${sql.raw(purchaseSettlementConflictRawSql("party", '"Purchase"'))}
        THEN NULL
        ELSE (SELECT min(shortcode) FROM sole_users) END
    WHEN (SELECT count(*) FROM evidence_parties) = 1 THEN (SELECT min(shortcode) FROM evidence_parties)
    ELSE NULL END
)`;
