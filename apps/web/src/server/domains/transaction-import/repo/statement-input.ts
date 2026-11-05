import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordProviderStatus } from "@cubby/schemas/source-transaction-record";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  CHARGE_STATE,
  chargeKeyOf,
  chargeStateOf,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";

import {
  sourceOccurrenceSuppressed,
  sourceObservations,
} from "./source-observation-state";

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

  return sql`SELECT seen.source, ${chargeKeyOf("seen")} AS "chargeKey" FROM ${sourceObservations} seen
    WHERE NOT ${sourceOccurrenceSuppressed(sql`seen."occurrenceId"`)} AND seen."occurrenceId" IS NOT NULL AND seen."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND ${notDeleted("seen")} ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}`;
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
    WHERE NOT ${sourceOccurrenceSuppressed(sql`cs."occurrenceId"`)} AND cs."occurrenceId" IS NOT NULL AND cs."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND NOT cs.ignored AND NOT cs.superseded
      AND (cs."acceptedTransactionId" IS NULL OR cs.shortcode IS NOT NULL)
      AND ((cs.shortcode IS NULL AND EXISTS (SELECT 1 FROM ${sourceObservations} head
        WHERE head.source=cs.source AND head."chargeKey"=cs."chargeKey" AND head.current
          AND head."withdrawnAt" IS NULL AND head.amount <> 0 AND ${notDeleted("head")}))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" changed
          JOIN ${sourceObservations} head ON head.source=cs.source AND head."chargeKey"=cs."chargeKey"
          WHERE changed.shortcode=cs.shortcode AND ${notDeleted("changed")}
            AND head.current AND ${notDeleted("head")}
            AND ((head."withdrawnAt" IS NOT NULL AND changed.status <> ${financialTransactionStatus.enum.void}) OR
              (head."withdrawnAt" IS NULL AND (changed.status = ${financialTransactionStatus.enum.void} OR round(changed.amount::numeric,2) <> round(head.amount::numeric,2)
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.posted} OR changed."postedDate" IS DISTINCT FROM head."statementDate"))
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending} AND changed.status <> ${financialTransactionStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.pending} OR changed."transactionDate" IS DISTINCT FROM head."statementDate"))))))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" ft
        WHERE ft.shortcode = cs.shortcode AND ${notDeleted("ft")}
          AND ft.status IN (${financialTransactionStatus.enum.posted}, ${financialTransactionStatus.enum.pending}, ${financialTransactionStatus.enum.observed})
          AND ft.kind IN (${financialTransactionKind.enum.purchase},${financialTransactionKind.enum.refund},${financialTransactionKind.enum.fee})
          AND (NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" allocation
              WHERE allocation."transactionId" = ft.id AND ${notDeleted("allocation")})
            OR EXISTS (SELECT 1 FROM "Suggestion" existing
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
    JOIN "SourceOccurrence" occurrence ON occurrence."acceptedTransactionId" = ft.id
      AND occurrence."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND occurrence."supersededByOccurrenceId" IS NULL
      AND ${notDeleted("occurrence")}
    JOIN ${sourceObservations} sr ON sr.id = occurrence."currentObservationId"
      AND ${notDeleted("sr")} AND sr."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending}
    WHERE ${notDeleted("ft")} AND ft.status = ${financialTransactionStatus.enum.pending}
      ${page?.after ? sql`AND ft.id > ${page.after}::uuid` : sql``}
      AND ft."accountId" IN (${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      -- includes-deleted: every reserved corroborating occurrence can block a pending transfer.
      AND NOT EXISTS (
        -- includes-deleted: every reserved corroborating occurrence can block a pending transfer.
        SELECT 1 FROM "SourceOccurrence" other
        LEFT JOIN "SourceTransactionRecord" held ON held.id = other."currentObservationId"
        WHERE other."acceptedTransactionId" = ft.id
          AND (other."deletedAt" IS NOT NULL OR other."reviewState" <> ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
            OR other."supersededByOccurrenceId" IS NOT NULL
            OR held.id IS NULL OR held."deletedAt" IS NOT NULL
            OR held."providerStatus" IS DISTINCT FROM ${sourceTransactionRecordProviderStatus.enum.pending})
      )
      -- includes-deleted: unresolved historical aliases never authorize pending movement.
      AND NOT EXISTS (
        -- includes-deleted: unresolved historical aliases never authorize pending movement.
        SELECT 1 FROM "FinancialEvidenceAlias" unresolved
        LEFT JOIN "SourceOccurrence" resolved ON resolved.id=unresolved."occurrenceId"
        WHERE unresolved."historicalTransactionId" = ft.id
          AND (resolved.id IS NULL OR resolved."acceptedTransactionId" IS DISTINCT FROM ft.id))
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
      WHERE ${notDeleted("ft")} AND ft.status = ${financialTransactionStatus.enum.pending}
    `)
  ).rows.map((row) => String(row.id));
