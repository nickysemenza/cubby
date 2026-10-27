import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { related } from "~/server/db/helpers/related";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { workRunOwners } from "~/server/domains/run/repo/work-owners";

/** Original item evidence follows current source accounts; a payment does not establish access. */
export const workPurchaseSourceOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT authority.owner FROM "Purchase" p
  CROSS JOIN LATERAL (
    SELECT account."ledgerPartyId" AS owner
    FROM "VendorAccount" account
    WHERE p."vendorAccountId" IS NOT NULL AND account.id = p."vendorAccountId" AND ${notDeleted(alias(vendorAccount, "account"))}
    UNION ALL
    SELECT NULL::uuid WHERE p."vendorAccountId" IS NOT NULL AND NOT ${related(vendorAccount, (account) => sql`${account.id} = p."vendorAccountId"`).exists()}
    UNION ALL
    SELECT unnest(${workRunOwners(sql`p."runId"`)}) WHERE p."vendorAccountId" IS NULL
    UNION ALL
    SELECT CASE WHEN claim."vendorAccountId" IS NOT NULL THEN account."ledgerPartyId" ELSE claim."ledgerPartyId" END
    FROM "ImportSourceOrder" accepted
    JOIN "ImportSourceClaim" claim ON claim.id = accepted."sourceClaimId"
    LEFT JOIN "VendorAccount" account ON account.id = claim."vendorAccountId" AND ${notDeleted(alias(vendorAccount, "account"))}
    WHERE accepted."purchaseId" = p.id
  ) authority
  WHERE p.id = ${id} AND ${notDeleted(alias(purchase, "p"))}
)`;

const workPurchaseTenderOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT account."ledgerPartyId"
  FROM "FinancialTransactionAllocation" allocation
  JOIN "FinancialTransaction" transaction ON transaction.id = allocation."transactionId" AND ${notDeleted(alias(financialTransaction, "transaction"))}
  LEFT JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND ${notDeleted(alias(financialAccount, "account"))}
  WHERE allocation."purchaseId" = ${id} AND ${notDeleted(alias(financialTransactionAllocation, "allocation"))}
)`;

/** Financial reconciliation requires its source evidence and every current tender authority. */
export const workPurchaseOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM (
    SELECT CASE WHEN cardinality(original.owners) > 0 THEN original.owners ELSE ARRAY[NULL::uuid] END
      || ${workPurchaseTenderOwners(id)} AS owners
    FROM (SELECT ${workPurchaseSourceOwners(id)} AS owners) original
  ) authority CROSS JOIN LATERAL unnest(authority.owners) owner
)`;
