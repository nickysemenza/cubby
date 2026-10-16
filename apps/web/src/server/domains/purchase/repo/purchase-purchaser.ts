import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { sql } from "drizzle-orm";

import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";

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
    SELECT party.shortcode FROM "Email"
    JOIN "LedgerParty" party ON party.id = "Email"."ledgerPartyId"
      AND party."deletedAt" IS NULL AND party.kind = ${ledgerPartyKind.enum.member}
    WHERE "Email"."deletedAt" IS NULL AND EXISTS (
      SELECT 1 FROM (${emailPurchaseEvidenceSql("ignore")}) evidence
      WHERE evidence."purchaseId" = "Purchase".id AND evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked})
    )
  )
  SELECT CASE
    WHEN "Purchase"."purchaserOverrideId" IS NOT NULL THEN
      (SELECT shortcode FROM "LedgerParty" WHERE id = "Purchase"."purchaserOverrideId" AND "deletedAt" IS NULL)
    WHEN (SELECT count(*) FROM payment_accounts) > 0
      AND (SELECT count(*) FROM payment_accounts) = (SELECT count(*) FROM sole_users)
      AND (SELECT count(DISTINCT shortcode) FROM sole_users) = 1
      THEN (SELECT min(shortcode) FROM sole_users)
    WHEN (SELECT count(*) FROM evidence_parties) = 1 THEN (SELECT min(shortcode) FROM evidence_parties)
    ELSE NULL END
)`;
