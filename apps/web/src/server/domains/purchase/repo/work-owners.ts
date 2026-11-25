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
import { acceptedOrderPurchasesSql } from "~/server/domains/purchase-import/repo/accepted-order-read";
import { workRunOwners } from "~/server/domains/run/repo/work-owners";
import type { WorkCte } from "~/server/generic/work-queue/repo/work-source";

/** Shared by Work sources that route accepted Purchase evidence. */
export const workAcceptedOrderOwners = {
  name: "work_accepted_order_owners",
  sql: sql`SELECT jsonb_object_agg(owners."boundPurchaseId", owners.parties) AS by_purchase
    FROM (
      SELECT "boundPurchaseId", jsonb_agg(DISTINCT "ledgerPartyId") AS parties
      FROM ${acceptedOrderPurchasesSql} accepted
      WHERE "boundPurchaseId" IS NOT NULL
      GROUP BY "boundPurchaseId"
    ) owners`,
} satisfies WorkCte;

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
    SELECT party::uuid FROM jsonb_array_elements_text(
      (SELECT by_purchase FROM ${sql.identifier(workAcceptedOrderOwners.name)}) -> p.id::text
    ) party
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
    FROM (SELECT ${workPurchaseSourceOwners(id)} AS owners OFFSET 0) original
  ) authority CROSS JOIN LATERAL unnest(authority.owners) owner
)`;
