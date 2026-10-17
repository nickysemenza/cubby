/**
 * Whether a settling transaction's account could have paid a Purchase.
 *
 * Two independent questions, one definition each, shared by the Purchase
 * data-quality checks, the allocation write guards and the settlement
 * candidate ranker:
 *
 * - **party**: the order's vendor-account member is not anyone who could use
 *   the account on the charge date (owner, dated funder, primary cardholder,
 *   dated authorized user). A household-owned account, or an order with no
 *   vendor-account member, never conflicts.
 * - **tender**: the order's paying accounts are known and the account is not
 *   among them. Paying accounts are the member's explicit
 *   `purchasePaymentAccount` links when any exist, otherwise derived on read
 *   from payment evidence; evidence that does not resolve every line to
 *   exactly one account leaves them unknown, which never conflicts. Refunds
 *   are exempt: a credit lands wherever the vendor sends it.
 *
 * Raw-SQL builders take hand-qualified aliases, like `financial-reconciliation`.
 */

import {
  financialTransactionKind,
  type FinancialTransactionKind,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import type {
  FinancialAccountId,
  FinancialTransactionId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import {
  settlementConflictKind,
  type SettlementConflictKind,
} from "@cubby/schemas/purchase";
import { eq, inArray, sql } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { financialTransaction, purchase } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

export const settlementConflictKinds = settlementConflictKind.options;
export type { SettlementConflictKind };

const settlementKindList = purchaseSettlementKinds
  .map((kind) => `'${kind}'`)
  .join(", ");

/** A dated `{ledgerPartyId: shortcode, validFrom, validTo}` period covers `date`. */
const periodPartiesSql = (periods: string, date: string) => `(
  SELECT party.id FROM jsonb_array_elements(${periods}) period
  JOIN "LedgerParty" party
    ON party.shortcode = period->>'ledgerPartyId' AND party."deletedAt" IS NULL
  WHERE ${date} IS NOT NULL
    AND (period->>'validFrom' IS NULL OR (period->>'validFrom')::date <= ${date})
    AND (period->>'validTo' IS NULL OR ${date} <= (period->>'validTo')::date)
)`;

/**
 * Everyone who could use the account on `date`. Undated funding history falls
 * back to the owner, as in `accountFundingPartySql`.
 */
const accountPeopleSql = (account: string, date: string) => `(
  SELECT ${account}."ledgerPartyId"
  UNION SELECT ${account}."primaryCardholderId"
  UNION SELECT party_id FROM ${periodPartiesSql(`${account}."fundingPeriods"`, date)} funded(party_id)
  UNION SELECT party_id FROM ${periodPartiesSql(`${account}."authorizedUsers"`, date)} authorized(party_id)
)`;

/** True when the account's people admit `party` on `date` (see module doc). */
const accountAdmitsPartyRawSql = (
  account: string,
  date: string,
  party: string,
) => `(
  ${party} IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM ${accountPeopleSql(account, date)} people(id) WHERE people.id IS NOT NULL
  )
  OR EXISTS (
    SELECT 1 FROM ${accountPeopleSql(account, date)} people(id)
    JOIN "LedgerParty" person ON person.id = people.id AND person."deletedAt" IS NULL
    WHERE person.id = ${party} OR person.kind = 'household'
  )
)`;

/** The order's vendor-account member, or NULL. */
const purchaseMemberSql = (purchase: string) => `(
  SELECT va."ledgerPartyId" FROM "VendorAccount" va
  WHERE va.id = ${purchase}."vendorAccountId" AND va."deletedAt" IS NULL
)`;

/**
 * The one live account a payment evidence row names, or NULL when it names
 * none or several. Card digits resolve through `cardNumbers` on the UTC charge
 * day (an undated line admits only undated cards, as `cardLastFoursOn`); a
 * stored-value line resolves to the vendor's stored-value account owned by the
 * order's member (`FinancialAccount_provider_owner_key`).
 */
const evidenceAccountSql = (evidence: string, purchase: string) => `(
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(fa.id))[1] END
  FROM "FinancialAccount" fa
  WHERE fa."deletedAt" IS NULL AND (
    (${evidence}.tender = 'stored_value'
      AND fa.identity->>'kind' = 'stored_value'
      AND fa."providerVendorId" = ${purchase}."vendorId"
      AND fa."ledgerPartyId" = ${purchaseMemberSql(purchase)})
    OR (${evidence}.tender <> 'stored_value'
      AND ${evidence}."cardLastFour" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(fa."cardNumbers") = 'array' THEN fa."cardNumbers"
          ELSE '[]'::jsonb END) card
        WHERE card->>'last4' = ${evidence}."cardLastFour"
          AND CASE WHEN ${evidence}."chargedAt" IS NULL
            THEN card->>'validFrom' IS NULL AND card->>'validTo' IS NULL
            ELSE (card->>'validFrom' IS NULL OR (card->>'validFrom')::date <= ${evidence}."chargedAt"::date)
              AND (card->>'validTo' IS NULL OR ${evidence}."chargedAt"::date <= (card->>'validTo')::date)
          END))
  )
)`;

/**
 * The order's paying account ids (uuid[]), or NULL when unknown. Explicit links
 * win outright; otherwise every source whose payment lines each resolve to one
 * account contributes them (sources of one order agree on amounts, but an order
 * page may omit the tender an export names).
 */
export const purchasePayingAccountIdsRawSql = (purchase: string) => `(
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM "EntityLink" pay_link
      WHERE pay_link."fromEntityId" = ${purchase}.id
        AND pay_link.kind = 'purchasePaymentAccount'
        AND pay_link."deletedAt" IS NULL
    ) THEN (
      SELECT array_agg(pay_link."toEntityId") FROM "EntityLink" pay_link
      JOIN "FinancialAccount" linked_fa
        ON linked_fa.id = pay_link."toEntityId" AND linked_fa."deletedAt" IS NULL
      WHERE pay_link."fromEntityId" = ${purchase}.id
        AND pay_link.kind = 'purchasePaymentAccount'
        AND pay_link."deletedAt" IS NULL
    )
    ELSE (
      SELECT array_agg(DISTINCT resolved.account_id)
      FROM (
        SELECT line.account_id,
          bool_and(line.account_id IS NOT NULL) OVER (PARTITION BY line.claim_id) AS complete
        FROM (
          SELECT pay_evidence."sourceClaimId" AS claim_id,
            ${evidenceAccountSql("pay_evidence", purchase)} AS account_id
          FROM "PurchasePaymentEvidence" pay_evidence
          WHERE pay_evidence."purchaseId" = ${purchase}.id
        ) line
      ) resolved
      WHERE resolved.complete
    )
  END
)`;

/** One allocation's conflict of `kind`, given the purchase, account and transaction aliases. */
export const settlementConflictRawSql = (
  kind: SettlementConflictKind,
  aliases: { purchase: string; account: string; transaction: string },
) => {
  const { purchase, account, transaction } = aliases;
  if (kind === "party")
    return `NOT ${accountAdmitsPartyRawSql(
      account,
      `coalesce(${transaction}."transactionDate", ${transaction}."postedDate")`,
      purchaseMemberSql(purchase),
    )}`;
  return `(${transaction}.kind <> 'refund'
    AND coalesce(NOT (${account}.id = ANY((${purchasePayingAccountIdsRawSql(purchase)})::uuid[])), false))`;
};

const conflictingAllocationsRawSql = (
  select: string,
  kind: SettlementConflictKind,
  purchase: string,
) => `(
  SELECT ${select} FROM "FinancialTransactionAllocation" conflict_alloc
  JOIN "FinancialTransaction" conflict_tx
    ON conflict_tx.id = conflict_alloc."transactionId"
    AND conflict_tx."deletedAt" IS NULL
    AND conflict_tx.status <> 'void'
    AND conflict_tx.kind IN (${settlementKindList})
  JOIN "FinancialAccount" conflict_account
    ON conflict_account.id = conflict_tx."accountId"
  WHERE conflict_alloc."purchaseId" = ${purchase}.id
    AND conflict_alloc."deletedAt" IS NULL
    AND ${settlementConflictRawSql(kind, {
      purchase,
      account: "conflict_account",
      transaction: "conflict_tx",
    })}
)`;

/** A live settlement allocation on the purchase carries a conflict of `kind`. */
export const purchaseSettlementConflictRawSql = (
  kind: SettlementConflictKind,
  purchase: string,
) => `EXISTS ${conflictingAllocationsRawSql("1", kind, purchase)}`;

/**
 * The conflicting transactions, so an exception recorded for one charge
 * reopens when another conflicting charge is allocated.
 */
export const purchaseSettlementConflictFingerprintRawSql = (
  kind: SettlementConflictKind,
  purchase: string,
) =>
  conflictingAllocationsRawSql(
    "array_agg(conflict_tx.id ORDER BY conflict_tx.id)",
    kind,
    purchase,
  );

/**
 * Conflicts an allocation of one charge onto each purchase would carry, for
 * write guards and candidate ranking. Purchases with none are omitted.
 */
export async function findSettlementConflicts(
  dbc: DrizzleClient | DrizzleTransaction,
  input: {
    accountId: FinancialAccountId;
    kind: FinancialTransactionKind;
    transactionDate: string | null;
    purchaseIds: readonly PurchaseId[];
  },
): Promise<Map<PurchaseId, SettlementConflictKind[]>> {
  const conflicts = new Map<PurchaseId, SettlementConflictKind[]>();
  if (input.purchaseIds.length === 0) return conflicts;
  const aliases = {
    purchase: "candidate_purchase",
    account: "charge_account",
    transaction: "charge",
  };
  const rows = await dbc.execute<{
    purchaseId: PurchaseId;
    party: boolean;
    tender: boolean;
  }>(sql`
    WITH charge AS (
      SELECT ${input.kind}::text AS kind,
        ${input.transactionDate}::date AS "transactionDate",
        NULL::date AS "postedDate"
    )
    SELECT candidate_purchase.id AS "purchaseId",
      ${sql.raw(settlementConflictRawSql("party", aliases))} AS party,
      ${sql.raw(settlementConflictRawSql("tender", aliases))} AS tender
    FROM "Purchase" candidate_purchase
    CROSS JOIN charge
    JOIN "FinancialAccount" charge_account ON charge_account.id = ${input.accountId}::uuid
    WHERE candidate_purchase.id IN (${sql.join(
      input.purchaseIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  for (const row of rows.rows) {
    const kinds = settlementConflictKinds.filter((kind) => row[kind]);
    if (kinds.length > 0) conflicts.set(row.purchaseId, kinds);
  }
  return conflicts;
}

/** `findSettlementConflicts` for an existing transaction's account, kind and date. */
export async function transactionSettlementConflicts(
  tx: DrizzleTransaction,
  input: {
    transactionId: FinancialTransactionId;
    purchaseIds: readonly PurchaseId[];
  },
): Promise<Map<PurchaseId, SettlementConflictKind[]>> {
  if (input.purchaseIds.length === 0) return new Map();
  const [charge] = await tx
    .select({
      accountId: financialTransaction.accountId,
      kind: financialTransaction.kind,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
    })
    .from(financialTransaction)
    .where(eq(financialTransaction.id, input.transactionId));
  if (!charge) return new Map();
  return findSettlementConflicts(tx, {
    accountId: charge.accountId,
    kind: financialTransactionKind.parse(charge.kind),
    transactionDate: charge.transactionDate ?? charge.postedDate,
    purchaseIds: input.purchaseIds,
  });
}

const conflictSentence = {
  party:
    "its account is not one the order's vendor-account member could use on that date",
  tender: "its account is not among the accounts that paid the order",
} as const satisfies Record<SettlementConflictKind, string>;

/**
 * Refuse allocating a charge onto purchases it conflicts with. Applies to every
 * allocation write; `finance.allocate_settlement` alone may pass an explicit
 * acknowledgement, which records the matching data exception instead.
 */
export async function refuseSettlementConflicts(
  tx: DrizzleTransaction,
  input: {
    transactionId: FinancialTransactionId;
    purchaseIds: readonly PurchaseId[];
    /** Conflicts the charge already carried before this write; not new. */
    existing?: ReadonlyMap<PurchaseId, readonly SettlementConflictKind[]>;
  },
): Promise<void> {
  const conflicts = await transactionSettlementConflicts(tx, input);
  for (const [purchaseId, kinds] of conflicts) {
    const fresh = kinds.filter(
      (kind) => !input.existing?.get(purchaseId)?.includes(kind),
    );
    if (fresh.length > 0) conflicts.set(purchaseId, fresh);
    else conflicts.delete(purchaseId);
  }
  if (conflicts.size === 0) return;
  const codes = await tx
    .select({ id: purchase.id, shortcode: purchase.shortcode })
    .from(purchase)
    .where(inArray(purchase.id, [...conflicts.keys()]));
  const detail = codes
    .map(
      (row) =>
        `${row.shortcode}: ${(conflicts.get(row.id) ?? [])
          .map((kind) => conflictSentence[kind])
          .join("; ")}`,
    )
    .join(". ");
  throw createAppError(
    "CONSTRAINT_VIOLATION",
    `This charge cannot settle ${detail}. Allocate it to the order its account paid, link the paying account to the order, or use finance.allocate_settlement with acknowledgeConflicts and a note.`,
  );
}
