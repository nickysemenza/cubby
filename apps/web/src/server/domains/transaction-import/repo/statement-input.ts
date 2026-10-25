import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { sourceTransactionRecordProviderStatus } from "@cubby/schemas/source-transaction-record";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";

import { CHARGE_STATE, chargeKeyOf, chargeStateOf } from "./statement-charge";

/** Which charge identities a generation or label pass covers; empty covers the ledger. */
export type StatementSuggestionScope = {
  /** Only the charges one import observed. */
  importId?: string | null;
  /**
   * Only charges that resolve to these live FinancialAccounts using the
   * statement preview's stored, provider, card and settlement account rules.
   */
  accountIds?: readonly string[];
  /** Only charges dated on or after this day (`YYYY-MM-DD`). */
  since?: string | null;
};

export const scopedStatementChargeKeys = (scope: StatementSuggestionScope) => {
  const { importId, since } = scope;
  // A scope selects whole charges, so the charge's state still reads every
  // live observation of it.
  const filters = [
    ...(importId
      ? [
          sql`(seen.id IN (SELECT m."statementRowId" FROM ${transactionImportMembers} m WHERE m."importId" = ${importId}::uuid) OR seen."withdrawalImportId" = ${importId}::uuid)`,
        ]
      : []),
    ...(since ? [sql`seen."statementDate" >= ${since}::date`] : []),
  ];

  return sql`SELECT seen.source, ${chargeKeyOf("seen")} AS "chargeKey" FROM "SourceTransactionRecord" seen
    WHERE seen."deletedAt" IS NULL ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}`;
};

/** Bounded identities first; eligibility still aggregates every live observation of each key. */
export const statementInputChargeKeys = (
  scope: StatementSuggestionScope,
  after: { source: string; chargeKey: string } | null,
  limit: number,
) => sql`
  SELECT DISTINCT keys.source, keys."chargeKey" FROM (${scopedStatementChargeKeys(scope)}) keys
  ${after ? sql`WHERE (keys.source,keys."chargeKey") > (${after.source},${after.chargeKey})` : sql``}
  ORDER BY keys.source,keys."chargeKey" LIMIT ${limit}`;

/** Current generation inputs; scope selects charge keys before aggregating all live observations. */
export const statementInputCharges = (
  scope: StatementSuggestionScope,
  keys?: readonly { source: string; chargeKey: string }[],
) => {
  // Cursor admission selects whole charge identities before aggregation; every
  // retained observation of each admitted identity still participates.
  const chargeFilters = [
    ...(scope.importId || scope.since
      ? [
          sql`(r.source, ${chargeKeyOf("r")}) IN (${scopedStatementChargeKeys(scope)})`,
        ]
      : []),
    ...(keys
      ? [
          keys.length
            ? sql`(r.source,${chargeKeyOf("r")}) IN (${sql.join(
                keys.map((key) => sql`(${key.source},${key.chargeKey})`),
                sql`, `,
              )})`
            : sql`false`,
        ]
      : []),
  ];
  const state = chargeFilters.length
    ? chargeStateOf(sql.join(chargeFilters, sql` AND `))
    : CHARGE_STATE;
  return sql`
    SELECT cs.source, cs."chargeKey" FROM ${state} cs
    WHERE NOT cs.ignored AND NOT cs.superseded
      AND ((cs.shortcode IS NULL AND EXISTS (SELECT 1 FROM "SourceTransactionRecord" head
        WHERE head.source=cs.source AND head."chargeKey"=cs."chargeKey" AND head.current
          AND head."withdrawnAt" IS NULL AND head.amount <> 0 AND head."deletedAt" IS NULL))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" changed
          JOIN "SourceTransactionRecord" head ON head.source=cs.source AND head."chargeKey"=cs."chargeKey"
          WHERE changed.shortcode=cs.shortcode AND changed."deletedAt" IS NULL
            AND head.current AND head."deletedAt" IS NULL
            AND ((head."withdrawnAt" IS NOT NULL AND changed.status <> ${financialTransactionStatus.enum.void}) OR
              (head."withdrawnAt" IS NULL AND (changed.status = ${financialTransactionStatus.enum.void} OR round(changed.amount::numeric,2) <> round(head.amount::numeric,2)
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.posted} OR changed."postedDate" IS DISTINCT FROM head."statementDate"))
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending} AND changed.status <> ${financialTransactionStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.pending} OR changed."transactionDate" IS DISTINCT FROM head."statementDate"))))))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" ft
        WHERE ft.shortcode = cs.shortcode AND ft."deletedAt" IS NULL
          AND ft.status IN (${financialTransactionStatus.enum.posted}, ${financialTransactionStatus.enum.pending}, ${financialTransactionStatus.enum.observed})
          AND ft.kind IN (${financialTransactionKind.enum.purchase},${financialTransactionKind.enum.refund},${financialTransactionKind.enum.fee})
          AND (NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" allocation
              WHERE allocation."transactionId" = ft.id AND allocation."deletedAt" IS NULL)
            OR EXISTS (SELECT 1 FROM "AssessmentState" existing
              WHERE existing.family = ${assessmentFamily.enum.statement_transaction} AND existing.active
                AND existing.status = ${suggestionStatus.enum.pending}
                AND existing.data->>${"source"} = cs.source AND existing.data->>${"chargeKey"} = cs."chargeKey"
                AND existing.data->>${"recommended"} = ${statementTransactionAction.enum.book}))))
  `;
};

/** Every live settlement reference must have live provider-pending evidence. */
export const statementPendingInputTransactions = (
  accountIds: readonly string[],
  input?: {
    page?: { after: string | null; limit: number };
    scope?: StatementSuggestionScope;
  },
) => {
  const { page, scope } = input ?? {};
  // Admit whole holds after aggregation so scoped membership never discards
  // their pending evidence from other collections or settlement references.
  return sql`
    SELECT ft.id, ft."accountId", ft.amount, ft.status, ft."postedDate",
      ft."transactionDate", ft.merchant, ft."rawDescription",
      array_agg(DISTINCT sr.id) AS "pendingRowIds"
    FROM "FinancialTransaction" ft
    JOIN "EntityExternalId" fx ON fx."entityId" = ft.id
      AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
    JOIN "SourceTransactionRecord" sr ON sr.source = fx.source AND sr."externalId" = fx."externalId"
      AND sr."deletedAt" IS NULL AND sr."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending}
    WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
      ${page?.after ? sql`AND ft.id > ${page.after}::uuid` : sql``}
      AND ft."accountId" IN (${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1 FROM "EntityExternalId" other
        WHERE other."entityId" = ft.id AND other.kind = 'settlement_ref'
          AND other."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "SourceTransactionRecord" held
            WHERE held.source = other.source AND held."externalId" = other."externalId"
              AND held."deletedAt" IS NULL AND held."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending}
          )
      )
    GROUP BY ft.id
    ${
      scope?.importId || scope?.since
        ? sql`HAVING bool_or((sr.source, ${chargeKeyOf("sr")}) IN (${scopedStatementChargeKeys(scope)}))`
        : sql``
    }
    ORDER BY ft.id
    ${page ? sql`LIMIT ${page.limit}` : sql``}
  `;
};

/** Candidate accounts only; the hold query intersects charge membership/date scope. */
export const statementHoldAccounts = async (
  db: Database | DrizzleTransaction,
  scope?: StatementSuggestionScope,
) =>
  scope?.accountIds ??
  (
    await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT DISTINCT ft."accountId" AS id FROM "FinancialTransaction" ft
      WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
    `)
  ).rows.map((row) => String(row.id));
