import { entitySchema } from "@cubby/schemas/entity";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { sql, type SQL } from "drizzle-orm";

/** A bound, deleted account stays unresolved rather than falling back to its actor. */
export const workRunOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT CASE WHEN work_source_run."vendorAccountId" IS NOT NULL THEN account."ledgerPartyId"
    ELSE work_source_run."ledgerPartyId" END
  FROM "Run" work_source_run
  LEFT JOIN "VendorAccount" account ON account.id = work_source_run."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE work_source_run.id = ${id} AND work_source_run."deletedAt" IS NULL
)`;

/** Retained Run controls require the live member/login and current source account
 * to agree. A live Run has exactly one source owner; compare that scalar here
 * rather than rereading the Run through source-owner arrays for each candidate. */
export const workRunReviewOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT CASE WHEN member."userId" = r."actorUserId"
    AND (CASE WHEN r."vendorAccountId" IS NOT NULL THEN account."ledgerPartyId"
      ELSE r."ledgerPartyId" END) = r."ledgerPartyId"
    THEN r."ledgerPartyId" ELSE NULL::uuid END
  FROM "Run" r
  LEFT JOIN "LedgerParty" member ON member.id = r."ledgerPartyId"
    AND member.kind = ${ledgerPartyKind.enum.member} AND member."deletedAt" IS NULL
  LEFT JOIN "VendorAccount" account ON account.id = r."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE r.id = ${id} AND r."deletedAt" IS NULL
)`;

/** Original item evidence follows current source accounts; a payment does not establish access. */
export const workPurchaseSourceOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT authority.owner FROM "Purchase" p
  CROSS JOIN LATERAL (
    SELECT account."ledgerPartyId" AS owner
    FROM "VendorAccount" account
    WHERE p."vendorAccountId" IS NOT NULL AND account.id = p."vendorAccountId" AND account."deletedAt" IS NULL
    UNION ALL
    SELECT NULL::uuid WHERE p."vendorAccountId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "VendorAccount" account WHERE account.id = p."vendorAccountId" AND account."deletedAt" IS NULL
    )
    UNION ALL
    SELECT unnest(${workRunOwners(sql`p."runId"`)}) WHERE p."vendorAccountId" IS NULL
    UNION ALL
    SELECT CASE WHEN claim."vendorAccountId" IS NOT NULL THEN account."ledgerPartyId" ELSE claim."ledgerPartyId" END
    FROM "ImportSourceOrder" accepted
    JOIN "ImportSourceClaim" claim ON claim.id = accepted."sourceClaimId"
    LEFT JOIN "VendorAccount" account ON account.id = claim."vendorAccountId" AND account."deletedAt" IS NULL
    WHERE accepted."purchaseId" = p.id
  ) authority
  WHERE p.id = ${id} AND p."deletedAt" IS NULL
)`;

const workPurchaseTenderOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT account."ledgerPartyId"
  FROM "FinancialTransactionAllocation" allocation
  JOIN "FinancialTransaction" transaction ON transaction.id = allocation."transactionId" AND transaction."deletedAt" IS NULL
  LEFT JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND account."deletedAt" IS NULL
  WHERE allocation."purchaseId" = ${id} AND allocation."deletedAt" IS NULL
)`;

/** Financial reconciliation requires its source evidence and every current tender authority. */
export const workPurchaseOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM (
    SELECT CASE WHEN cardinality(original.owners) > 0 THEN original.owners ELSE ARRAY[NULL::uuid] END
      || ${workPurchaseTenderOwners(id)} AS owners
    FROM (SELECT ${workPurchaseSourceOwners(id)} AS owners) original
  ) authority CROSS JOIN LATERAL unnest(authority.owners) owner
)`;

export const workExpenseSourceOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "Expense" source_expense
  CROSS JOIN LATERAL unnest(${workPurchaseSourceOwners(sql`source_expense."purchaseId"`)}) owner
  WHERE source_expense.id = ${id} AND source_expense."deletedAt" IS NULL
)`;

export const workExpenseOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "Expense" e
  CROSS JOIN LATERAL (
    SELECT unnest(${workPurchaseOwners(sql`e."purchaseId"`)}) AS owner
    UNION ALL
    SELECT account."ledgerPartyId"
    FROM "FinancialTransaction" transaction
    LEFT JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND account."deletedAt" IS NULL
    WHERE transaction.shortcode = e."bookingTransactionCode" AND transaction."deletedAt" IS NULL
  ) authority
  WHERE e.id = ${id} AND e."deletedAt" IS NULL
)`;

/** Source-document attachments take precedence over a public representative copy. */
export const workImageOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "EntityAttachment" attachment
  CROSS JOIN LATERAL (
    SELECT CASE WHEN cardinality(scope.owners) > 0 THEN scope.owners ELSE ARRAY[NULL::uuid] END AS owners
    FROM (SELECT CASE attachment."entityKind"
      WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseSourceOwners(sql`attachment."entityId"`)}
      WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT message."ledgerPartyId" FROM "Email" message WHERE message.id = attachment."entityId" AND message."deletedAt" IS NULL)
    END AS owners) scope
  ) source
  CROSS JOIN LATERAL unnest(source.owners) owner
  WHERE attachment."imageId" = ${id} AND attachment."deletedAt" IS NULL
    AND attachment."entityKind" IN (${entitySchema.enum.purchase}, ${entitySchema.enum.email})
)`;

export const workImageIsShared = (id: SQL): SQL => sql`NOT EXISTS (
  SELECT 1 FROM "EntityAttachment" attachment
  WHERE attachment."imageId" = ${id} AND attachment."deletedAt" IS NULL
    AND attachment."entityKind" IN (${entitySchema.enum.purchase}, ${entitySchema.enum.email})
) AND EXISTS (
  SELECT 1 FROM "EntityAttachment" attachment
  JOIN "Product" item ON item.id = attachment."entityId" AND item."deletedAt" IS NULL
  WHERE attachment."imageId" = ${id} AND attachment."deletedAt" IS NULL
    AND attachment."entityKind" = ${entitySchema.enum.product}
)`;
