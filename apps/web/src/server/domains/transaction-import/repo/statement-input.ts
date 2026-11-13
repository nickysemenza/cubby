import { suggestionStatus } from "@cubby/schemas/ai";
import {
  type FinancialTransactionImportRow,
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordProviderStatus } from "@cubby/schemas/source-transaction-record";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  chargeId,
  type ChargeRef,
} from "~/server/domains/transaction-import/policy/charge-identity";
import { sourceObservationFacts } from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  chargeKeyOf,
  chargeStateOf,
} from "~/server/domains/transaction-import/repo/statement-charge";

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

export const scopedStatementChargeKeys = (
  scope: StatementSuggestionScope,
  ownerFilter?: SQL,
) => {
  const { importId, since } = scope;
  // A scope selects whole charges, so the charge's state still reads every
  // live observation of it.
  const roots = importId
    ? sql`(SELECT m."statementRowId" AS id FROM ${transactionImportRecord} m WHERE m."importId"=${importId}::uuid
        UNION
        SELECT r.id FROM "SourceOccurrence" o JOIN "SourceTransactionRecord" r ON r."occurrenceId"=o.id
        WHERE o."withdrawalImportId"=${importId}::uuid)`
    : sql`"SourceTransactionRecord"`;
  return sql`SELECT r.source, o.shortcode AS "chargeKey"
    FROM ${roots} roots JOIN "SourceTransactionRecord" r ON r.id=roots.id
    JOIN "SourceOccurrence" o ON o.id=r."occurrenceId"
    WHERE ${notDeleted("r")}
      AND o."reviewState"=${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
      AND NOT ${sourceOccurrenceHasUnresolvedHistory(sql`o.id`, sql`o."acceptedTransactionId"`)}
      ${since ? sql`AND r."statementDate" >= ${since}::date` : sql``}
      ${ownerFilter ? sql`AND (${ownerFilter})` : sql``}`;
};

/** Current generation inputs; scope selects charge keys before aggregating all live observations. */
export const statementInputCharges = (
  scope: StatementSuggestionScope,
  keys?: readonly { source: string; chargeKey: string }[],
) => {
  // Cursor admission selects whole charge identities before aggregation; every
  // retained observation of each admitted identity still participates.
  const requestedKeys = requestedRows(
    keys ?? [],
    { source: "text", chargeKey: "text" },
    "requested_charge",
  );
  const chargeFilters = [
    ...(scope.importId || scope.since
      ? [
          sql`(r.source, ${chargeKeyOf("r")}) IN (${scopedStatementChargeKeys(scope)})`,
        ]
      : []),
    ...(keys
      ? [
          keys.length
            ? sql`EXISTS (SELECT 1 FROM ${requestedKeys.from} WHERE ${requestedKeys.col("source")}=r.source AND ${requestedKeys.col("chargeKey")}=${chargeKeyOf("r")})`
            : sql`false`,
        ]
      : []),
  ];
  const state = chargeFilters.length
    ? chargeStateOf(sql.join(chargeFilters, sql` AND `))
    : chargeStateOf(sql`true`);
  return sql`
    SELECT cs.source, cs."chargeKey" FROM ${state} cs
    WHERE cs."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND NOT cs.ignored AND NOT cs.superseded
      AND (cs."acceptedTransactionId" IS NULL OR cs.shortcode IS NOT NULL)
      AND ((cs.shortcode IS NULL AND EXISTS (SELECT 1 FROM ${sourceObservationFacts} head
        WHERE head.source=cs.source AND head."chargeKey"=cs."chargeKey" AND head.current
          AND head."withdrawnAt" IS NULL AND head.amount <> 0 AND ${notDeleted("head")}))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" changed
          JOIN ${sourceObservationFacts} head ON head.source=cs.source AND head."chargeKey"=cs."chargeKey"
          WHERE changed.shortcode=cs.shortcode AND ${notDeleted("changed")}
            AND head.current AND ${notDeleted("head")}
            AND ((head."withdrawnAt" IS NOT NULL AND changed.status <> ${financialTransactionStatus.enum.void}) OR
              (head."withdrawnAt" IS NULL AND (changed.status = ${financialTransactionStatus.enum.void} OR true
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.posted} OR changed."postedDate" IS DISTINCT FROM head."statementDate"))
                OR (head."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending} AND changed.status <> ${financialTransactionStatus.enum.posted} AND (changed.status <> ${financialTransactionStatus.enum.pending} OR changed."transactionDate" IS DISTINCT FROM head."statementDate"))))))
        OR EXISTS (SELECT 1 FROM "FinancialTransaction" ft
        WHERE ft.shortcode = cs.shortcode AND ${notDeleted("ft")}
          AND ft.status IN (${financialTransactionStatus.enum.posted}, ${financialTransactionStatus.enum.pending}, ${financialTransactionStatus.enum.observed})
          AND ft.kind IN (${financialTransactionKind.enum.purchase},${financialTransactionKind.enum.refund},${financialTransactionKind.enum.fee})
          AND (NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" allocation
              WHERE allocation."transactionId" = ft.id AND ${notDeleted("allocation")})
            OR EXISTS (SELECT 1 FROM "Suggestion" existing
              WHERE existing.family = ${sqlEnumConstant(suggestionFamily, suggestionFamily.enum.statement_transaction)} AND existing.active
                AND existing.status = ${suggestionStatus.enum.pending}
                AND existing.data->>${sql.raw("'source'")} = cs.source AND existing.data->>${sql.raw("'chargeKey'")} = cs."chargeKey"
                AND existing.data->>'recommended' = ${statementTransactionAction.enum.book}))))
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
    SELECT ft.id, ft."accountId", (${minorToDollarsSql(sql`ft."amountMinor"`, "numeric")})::float8 AS amount, ft.status, ft."postedDate",
      ft."transactionDate", ft.merchant, ft."rawDescription",
      array_agg(DISTINCT sr.id) AS "pendingRowIds"
    FROM "FinancialTransaction" ft
    JOIN "SourceOccurrence" occurrence ON occurrence."acceptedTransactionId" = ft.id
      AND occurrence."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND occurrence."supersededByOccurrenceId" IS NULL
      AND ${notDeleted("occurrence")}
    JOIN ${sourceObservationFacts} sr ON sr.id = occurrence."currentObservationId"
      AND ${notDeleted("sr")} AND sr."providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending}
    WHERE ${notDeleted("ft")} AND ft.status = ${financialTransactionStatus.enum.pending}
      ${page?.after ? sql`AND ft.id > ${page.after}::uuid` : sql``}
      AND ft."accountId" = ANY(${uuidArrayParam(accountIds)})
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

/** Shared preview input for a charge's canonical observation. */
export const previewRowFor = (
  charge: ChargeRef,
  row: {
    source: string;
    accountDescriptor: string;
    statementDate: string;
    providerAmount: number;
    merchant: string | null;
    rawDescription: string;
    sourceCategory: string | null;
    providerNotes: string | null;
    importFingerprint: string;
    rowPosition: number | null;
    providerTransactionId: string | null;
    providerAccountId: string | null;
    providerStatus: "posted" | "pending" | null;
  },
): FinancialTransactionImportRow => ({
  key: chargeId(charge),
  source: row.source,
  account: row.accountDescriptor,
  date: row.statementDate,
  amount: row.providerAmount,
  merchant: row.merchant,
  originalStatement: row.rawDescription,
  category: row.sourceCategory,
  notes: row.providerNotes,
  importFingerprint: row.importFingerprint,
  ...(row.rowPosition === null ? {} : { rowPosition: row.rowPosition }),
  providerTransactionId: row.providerTransactionId,
  providerAccountId: row.providerAccountId,
  ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
});
