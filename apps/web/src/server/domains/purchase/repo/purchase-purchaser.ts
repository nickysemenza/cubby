import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { type SQL, sql } from "drizzle-orm";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { soleCardAccessSql } from "~/server/domains/financial-account/repo/purchaser";
import {
  purchaseMailMembersSql,
  purchaseMembersSql,
  purchaseRowSql,
  settlementPartyConflictSql,
  settlementTransactionSql,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";

/**
 * `(id, value)`: the effective purchaser shortcode of each purchase in
 * `purchases` (a `purchaseRowSql`-shaped relation), or NULL. Precedence: the
 * explicit override; unknown when a settlement_party_conflict exists (a
 * disagreement between the paying account and the order's member, not
 * attribution for either); the one member who alone could use every paying
 * card on both the order and charge dates; the one member its Vendor Account
 * and Email evidence name. Inherited attribution is never persisted.
 *
 * One definition for the column and the filter: over one correlated row it
 * reads that purchase's edges through their indexes; over every Purchase it
 * resolves each source in one pass, so a filter costs the same for a member
 * on nearly every order as for one on a few.
 */
const purchasePurchasersSql = (purchases: SQL) => sql`
  WITH purchase AS MATERIALIZED (${purchases}),
  mail AS MATERIALIZED (${purchaseMailMembersSql(sql`SELECT * FROM purchase`)}),
  settled AS (
    SELECT allocation."purchaseId", allocation.amount, purchase.date,
      coalesce(ft."transactionDate", ft."postedDate") AS charge_date,
      account."deletedAt" AS account_deleted_at,
      account."authorizedUsers",
      holder.shortcode AS holder,
      ${settlementPartyConflictSql(sql.raw("account"), sql.raw("ft"), sql`order_member.member`)} AS conflict
    FROM purchase
    JOIN "FinancialTransactionAllocation" allocation
      ON allocation."purchaseId" = purchase.id AND allocation."deletedAt" IS NULL
    JOIN "FinancialTransaction" ft
      ON ft.id = allocation."transactionId" AND ${settlementTransactionSql(sql.raw("ft"))}
    JOIN "FinancialAccount" account ON account.id = ft."accountId"
    JOIN (${purchaseMembersSql(sql`SELECT * FROM purchase`, sql`SELECT * FROM mail`)}) order_member
      ON order_member.id = purchase.id
    LEFT JOIN "LedgerParty" holder ON holder.id = ${effectiveFieldSql("financialAccount", "primaryCardholderId", "account")}
      AND holder."deletedAt" IS NULL AND holder.kind = ${ledgerPartyKind.enum.member}
  ), paying AS (
    -- A paying card is a live account with a positive allocation; its holder
    -- alone uses it when no authorized user's period covers either date.
    -- Shared charge-date access cannot identify a shopper from an earlier sole-use order date.
    SELECT settled.*, settled.holder IS NOT NULL AND
      ${soleCardAccessSql(sql`settled."authorizedUsers"`, sql`settled.date`)} AND
      ${soleCardAccessSql(sql`settled."authorizedUsers"`, sql`settled.charge_date`)} AS sole
    FROM settled
    WHERE settled.amount > 0 AND settled.account_deleted_at IS NULL
  ), cards AS (
    SELECT "purchaseId",
      bool_and(sole) AS sole,
      count(DISTINCT holder) FILTER (WHERE sole) AS holders,
      min(holder) FILTER (WHERE sole) AS holder
    FROM paying GROUP BY "purchaseId"
  ), evidence AS (
    SELECT "purchaseId", CASE WHEN count(*) = 1 THEN min(shortcode) END AS shortcode
    FROM (
      SELECT purchase.id AS "purchaseId", party.shortcode
      FROM purchase
      JOIN "VendorAccount" account ON account.id = purchase."vendorAccountId" AND account."deletedAt" IS NULL
      JOIN "LedgerParty" party ON party.id = account."ledgerPartyId"
        AND party."deletedAt" IS NULL AND party.kind = ${ledgerPartyKind.enum.member}
      UNION
      SELECT "purchaseId", shortcode FROM mail
    ) party
    GROUP BY "purchaseId"
  )
  SELECT purchase.id, CASE
    WHEN purchase."purchaserOverrideId" IS NOT NULL THEN override_party.shortcode
    WHEN EXISTS (SELECT 1 FROM settled WHERE settled."purchaseId" = purchase.id AND settled.conflict) THEN NULL
    WHEN cards.sole AND cards.holders = 1 THEN cards.holder
    ELSE evidence.shortcode
  END AS value
  FROM purchase
  LEFT JOIN "LedgerParty" override_party
    ON override_party.id = purchase."purchaserOverrideId" AND override_party."deletedAt" IS NULL
  LEFT JOIN cards ON cards."purchaseId" = purchase.id
  LEFT JOIN evidence ON evidence."purchaseId" = purchase.id
`;

/** Correlated to Purchase. */
export const purchasePurchaserSql = sql<LedgerPartyShortcode | null>`(
  SELECT purchaser.value FROM (${purchasePurchasersSql(purchaseRowSql(sql`"Purchase"`))}) purchaser
)`;

/** `("id", "value")` for every Purchase with an effective purchaser, as `purchasePurchaserSql` reads it. */
export const purchasePurchaserSetSql = sql`
  SELECT purchaser.id, purchaser.value
  FROM (${purchasePurchasersSql(sql`${purchaseRowSql(sql`"Purchase"`)} FROM "Purchase"`)}) purchaser
  WHERE purchaser.value IS NOT NULL
`;
