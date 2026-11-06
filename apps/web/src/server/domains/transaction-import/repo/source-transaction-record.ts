import type { ActorContext } from "@cubby/schemas/context";
import type {
  FindSourceTransactionRecordDriftInput,
  SourceTransactionRecordDriftCandidate,
  SourceTransactionRecordLegacyFilters,
  SourceTransactionRecordSelector,
  UpdateSourceTransactionRecordsInput,
} from "@cubby/schemas/source-transaction-record";
import { sourceTransactionRecordMatchState } from "@cubby/schemas/source-transaction-record";
import { and, eq, or, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  formatSearchTerm,
  notDeleted,
  rangeConditions,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { financialAccount, sourceTransactionRecord } from "~/server/db/schema";
import {
  sourceObservationColumns,
  sourceObservationFrom,
  sourceObservationFacts,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import { createAppError } from "~/server/errors/app-error";

import { updateSourceObservationJudgments } from "./source-occurrence";

const FROM_WITH_REFS = sql`FROM ${sourceObservationFrom}`;
const matchStateSql = sourceObservationColumns.matchState;

const importFingerprint = sql<string>`(
  SELECT si.fingerprint FROM "TransactionImport" si
  WHERE si.id = "SourceTransactionRecord"."batchId"
)`;

type SourceTransactionRecordSqlValue = string | number | Date | null;
/**
 * The reads run as raw SQL, so values arrive as the pg driver types them rather
 * than as drizzle's column modes: timestamps and `date` columns come back as
 * Date objects, numerics as strings. Coerce here so the output contract is the
 * same whichever way a row was fetched.
 */
const asDate = (value: SourceTransactionRecordSqlValue): Date =>
  value instanceof Date ? value : new Date(String(value));

const asPlainDate = (value: SourceTransactionRecordSqlValue): string => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
};

const observedInImport = (fingerprint: string) => sql`EXISTS (
  SELECT 1 FROM ${transactionImportMembers} member
  JOIN "TransactionImport" si ON si.id = member."importId"
  WHERE member."statementRowId" = "SourceTransactionRecord".id
    AND si.fingerprint = ${fingerprint}
    AND si.source = "SourceTransactionRecord".source AND ${notDeleted("si")}
)`;

const buildConditions = (
  filters: SourceTransactionRecordLegacyFilters,
): SQL[] => {
  const conditions: SQL[] = [notDeleted(sourceTransactionRecord)];
  if (filters.source)
    conditions.push(eq(sourceTransactionRecord.source, filters.source));
  // Addressed by the export's client-supplied fingerprint, never its uuid: a
  // uuid must not reach a URL or an MCP payload.
  if (filters.importFingerprint)
    conditions.push(observedInImport(filters.importFingerprint));
  // Filtered by the account's public shortcode, resolved inline. An unknown
  // code yields NULL and therefore matches nothing, rather than widening to an
  // unfiltered query.
  if (filters.accountId)
    conditions.push(
      sql`${sourceObservationColumns.accountId} = (
        SELECT fa.id FROM "FinancialAccount" fa
        WHERE fa.shortcode = ${filters.accountId} AND ${notDeleted("fa")}
      )`,
    );
  if (filters.sourceCategory)
    conditions.push(
      eq(sourceTransactionRecord.sourceCategory, filters.sourceCategory),
    );
  if (filters.disposition)
    conditions.push(
      eq(sourceObservationColumns.disposition, filters.disposition),
    );
  if (filters.dispositionReason)
    conditions.push(
      eq(sourceObservationColumns.dispositionReason, filters.dispositionReason),
    );
  if (filters.matchState)
    conditions.push(sql`${matchStateSql} = ${filters.matchState}`);
  if (filters.dateFrom)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} >= ${filters.dateFrom}`,
    );
  if (filters.dateTo)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} <= ${filters.dateTo}`,
    );
  conditions.push(
    ...rangeConditions(
      sourceObservationColumns.amount,
      filters,
      "amount",
    ).filter((c): c is SQL => c !== undefined),
  );
  if (filters.search) {
    const search = formatSearchTerm(
      sourceTransactionRecord.rawDescription,
      filters.search,
    );
    if (search) conditions.push(search);
  }
  return conditions;
};

export async function getSourceTransactionRecordSummary(
  db: Database,
  filters: SourceTransactionRecordLegacyFilters,
) {
  const where = and(...buildConditions(filters))!;
  const { rows } = await unwrapDb(db).execute<{
    total: number;
    matched: number;
    held: number;
    heldHistorical: number;
    heldWithoutHistoricalLinks: number;
    unmatched: number;
    ignored: number;
    superseded: number;
    amountTotal: string;
    matchedAmount: string;
    heldAmount: string;
    unmatchedAmount: string;
    ignoredAmount: string;
    supersededAmount: string;
    unmatchedCharges: number;
  }>(sql`
    SELECT
      count(*)::int AS total,
      COALESCE(sum(amount), 0) AS "amountTotal",
      ${sql.join(
        sourceTransactionRecordMatchState.options.map(
          (state) => sql`
            count(*) FILTER (WHERE ms = ${state})::int AS ${sql.identifier(state)},
            COALESCE(sum(amount) FILTER (WHERE ms = ${state}), 0) AS ${sql.identifier(`${state}Amount`)}`,
        ),
        sql`,`,
      )},
      count(*) FILTER (WHERE ms = ${sourceTransactionRecordMatchState.enum.held} AND historical)::int AS "heldHistorical",
      count(*) FILTER (WHERE ms = ${sourceTransactionRecordMatchState.enum.held} AND NOT historical)::int AS "heldWithoutHistoricalLinks",
      count(DISTINCT charge) FILTER (WHERE ms = ${sourceTransactionRecordMatchState.enum.unmatched})::int AS "unmatchedCharges"
    FROM (
      SELECT cardinality(${sourceObservationColumns.historicalTransactionIds}) > 0 AS historical, ${matchStateSql} AS ms, ${sourceObservationColumns.amount} AS amount,
        "SourceTransactionRecord".source || ':' || ${chargeKeyOf('"SourceTransactionRecord"')} AS charge
      ${FROM_WITH_REFS}
      WHERE ${where}
    ) t
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    matched: Number(row?.matched ?? 0),
    held: Number(row?.held ?? 0),
    heldHistorical: Number(row?.heldHistorical ?? 0),
    heldWithoutHistoricalLinks: Number(row?.heldWithoutHistoricalLinks ?? 0),
    unmatched: Number(row?.unmatched ?? 0),
    ignored: Number(row?.ignored ?? 0),
    superseded: Number(row?.superseded ?? 0),
    amountTotal: Number(row?.amountTotal ?? 0),
    matchedAmount: Number(row?.matchedAmount ?? 0),
    heldAmount: Number(row?.heldAmount ?? 0),
    unmatchedAmount: Number(row?.unmatchedAmount ?? 0),
    ignoredAmount: Number(row?.ignoredAmount ?? 0),
    supersededAmount: Number(row?.supersededAmount ?? 0),
    unmatchedCharges: Number(row?.unmatchedCharges ?? 0),
  };
}

export { recordSourceTransactionRecords } from "./source-intake";

export async function findSourceTransactionRecordDrift(
  db: Database,
  input: FindSourceTransactionRecordDriftInput,
) {
  const conditions: SQL[] = [
    notDeleted(sourceTransactionRecord),
    // An already-linked predecessor is a settled question. Only the predecessor
    // carries the link, so a resolved pair leaves one live row in its group and
    // the `count(*) > 1` gate drops it.
    sql`${sourceObservationColumns.supersededByRowId} IS NULL`,
  ];
  if (input.source)
    conditions.push(eq(sourceTransactionRecord.source, input.source));
  if (input.dateFrom)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} >= ${input.dateFrom}`,
    );
  if (input.dateTo)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} <= ${input.dateTo}`,
    );
  if (input.importFingerprint)
    conditions.push(observedInImport(input.importFingerprint));
  const where = and(...conditions)!;
  // Exclude shared membership by default; this is not proof of historical identity.
  const unsharedPair = sql`NOT EXISTS (
    SELECT 1 FROM ${transactionImportMembers} left_member
    JOIN ${transactionImportMembers} right_member ON right_member."importId" = left_member."importId"
    WHERE left_member."statementRowId" = a.id AND right_member."statementRowId" = b.id
  )`;
  const sameBatchGate = input.includeSameBatch
    ? sql``
    : sql`HAVING bool_or(${unsharedPair})`;

  // One extra group so `truncated` reports the cut rather than implying the
  // sweep came back clean.
  const probe = input.limit + 1;
  const { rows } = await unwrapDb(db).execute<{
    source: string;
    accountDescriptor: string;
    statementDate: SourceTransactionRecordSqlValue;
    providerAmount: SourceTransactionRecordSqlValue;
    crossBatch: boolean;
    externalId: string;
    rawDescription: string;
    merchant: string | null;
    providerStatus: string | null;
    disposition: string;
    importFingerprint: string;
    createdAt: SourceTransactionRecordSqlValue;
  }>(sql`
    WITH eligible AS (
      SELECT id, source, "chargeKey", "accountDescriptor", "statementDate", "providerAmount", "createdAt"
      FROM ${sourceObservationFacts} "SourceTransactionRecord" WHERE ${where}
    ), drifted AS (
      SELECT a.source, a."accountDescriptor", a."statementDate", a."providerAmount",
             min(least(a."createdAt", b."createdAt")) AS "firstSeen",
             bool_or(${unsharedPair}) AS "crossBatch"
      FROM eligible a
      JOIN eligible b ON a.id < b.id AND a."chargeKey" <> b."chargeKey"
        AND a.source = b.source AND a."accountDescriptor" = b."accountDescriptor"
        AND a."statementDate" = b."statementDate" AND a."providerAmount" = b."providerAmount"
      GROUP BY a.source, a."accountDescriptor", a."statementDate", a."providerAmount"
      ${sameBatchGate}
      ORDER BY "crossBatch" DESC, "firstSeen" DESC
      LIMIT ${probe}
    )
    SELECT "SourceTransactionRecord"."source",
           "SourceTransactionRecord"."accountDescriptor",
           "SourceTransactionRecord"."statementDate",
           "SourceTransactionRecord"."providerAmount",
           d."crossBatch",
           "SourceTransactionRecord"."externalId",
           "SourceTransactionRecord"."rawDescription",
           "SourceTransactionRecord"."merchant",
           "SourceTransactionRecord"."providerStatus",
           "SourceTransactionRecord"."disposition",
           ${importFingerprint} AS "importFingerprint",
           "SourceTransactionRecord"."createdAt"
    FROM ${sourceObservationFacts} "SourceTransactionRecord"
    JOIN drifted d
      ON d."source" = "SourceTransactionRecord"."source"
     AND d."accountDescriptor" = "SourceTransactionRecord"."accountDescriptor"
     AND d."statementDate" = "SourceTransactionRecord"."statementDate"
     AND d."providerAmount" = "SourceTransactionRecord"."providerAmount"
    WHERE ${where}
    ORDER BY d."firstSeen" DESC, "SourceTransactionRecord"."createdAt" ASC,
             "SourceTransactionRecord"."externalId" ASC
  `);

  const byGroup = new Map<string, SourceTransactionRecordDriftCandidate>();
  for (const row of rows) {
    const statementDate = asPlainDate(row.statementDate);
    const providerAmount = Number(row.providerAmount);
    const key = `${row.source}|${row.accountDescriptor}|${statementDate}|${providerAmount}`;
    const group = byGroup.get(key) ?? {
      source: row.source,
      accountDescriptor: row.accountDescriptor,
      statementDate,
      providerAmount,
      crossBatch: row.crossBatch,
      rows: [],
    };
    group.rows.push({
      externalId: row.externalId,
      rawDescription: row.rawDescription,
      merchant: row.merchant,
      providerStatus:
        row.providerStatus === "posted" || row.providerStatus === "pending"
          ? row.providerStatus
          : null,
      disposition: row.disposition === "ignored" ? "ignored" : "open",
      importFingerprint: row.importFingerprint,
      createdAt: asDate(row.createdAt),
    });
    byGroup.set(key, group);
  }

  const candidates = [...byGroup.values()];
  return {
    candidates: candidates.slice(0, input.limit),
    truncated: candidates.length > input.limit,
  };
}

const selectorConditions = (selector: SourceTransactionRecordSelector): SQL => {
  if ("externalIds" in selector)
    return and(
      notDeleted(sourceTransactionRecord),
      eq(sourceTransactionRecord.source, selector.source),
      or(
        sql`${sourceObservationColumns.externalId} IN (${sql.join(
          selector.externalIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        and(
          eq(sourceObservationColumns.current, true),
          sql`${sourceObservationColumns.chargeKey} IN (${sql.join(
            selector.externalIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      ),
    )!;
  const conditions = buildConditions(selector.filter);
  // The schema's non-empty refine is a fast reject, not the guarantee: it can
  // only see whether a field was *supplied*, while `buildConditions` decides
  // whether a field actually *restricts* — and the two disagree on a supplied
  // but falsy value (`{search: ""}` is defined, yet skipped below). Checking the
  // produced conditions instead of a parallel notion of emptiness is what makes
  // this un-driftable: `buildConditions` always contributes `notDeleted`, so a
  // length of one means nothing narrowed it, and a bulk write addressing every
  // row is never what the caller meant.
  if (conditions.length <= 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Selector filter restricts nothing; it would address every statement row.",
    );
  return and(...conditions)!;
};

export async function updateSourceTransactionRecords(
  db: Database,
  input: UpdateSourceTransactionRecordsInput,
  actor: ActorContext,
) {
  const { data, selector } = input;
  return withTransaction(db, async (tx) => {
    const selected = await unwrapDb(tx)
      .select({ id: sourceObservationColumns.id })
      .from(sourceObservationFrom)
      .where(selectorConditions(selector));
    let accountId;
    if (data.accountId !== undefined) {
      if (data.accountId === null) accountId = null;
      else {
        const [account] = await unwrapDb(tx)
          .select({ id: financialAccount.id })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.shortcode, data.accountId),
              notDeleted(financialAccount),
            ),
          )
          .limit(1);
        if (!account)
          throw createAppError(
            "FINANCIAL_ACCOUNT_NOT_FOUND",
            "The selected financial account is no longer live.",
          );
        accountId = account.id;
      }
    }
    let successorId;
    if (data.supersededByExternalId !== undefined) {
      if (!("externalIds" in selector))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Replacement requires an explicit source observation selector.",
        );
      if (data.supersededByExternalId === null) successorId = null;
      else {
        const [successor] = await unwrapDb(tx)
          .select({ id: sourceObservationColumns.id })
          .from(sourceObservationFrom)
          .where(
            and(
              eq(sourceTransactionRecord.source, selector.source),
              eq(
                sourceObservationColumns.externalId,
                data.supersededByExternalId,
              ),
              notDeleted(sourceTransactionRecord),
            ),
          )
          .limit(1);
        if (!successor)
          throw createAppError(
            "REFERENCED_RECORD_MISSING",
            "The replacement source observation is no longer live.",
          );
        successorId = successor.id;
      }
    }
    return updateSourceObservationJudgments(
      tx,
      selected.map((row) => row.id),
      {
        accountId,
        supersededByRowId: successorId,
        disposition: data.disposition,
        dispositionReason: data.dispositionReason,
        dispositionNote: data.dispositionNote,
        notes: data.notes,
      },
      actor,
    );
  });
}

export {
  sourceTransactionRecordRepository,
  sourceTransactionRecordScaffold,
} from "./entity-repositories";
export { assertSourceTransactionRecordDeletionAllowed } from "./source-transaction-record-lifecycle";
