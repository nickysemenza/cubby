import { assessmentFamily } from "@cubby/schemas/assessment";
import { financialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import type {
  FinancialAccountId,
  SourceTransactionRecordId,
  TransactionImportId,
  FinancialTransactionId,
} from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import type {
  SourceTransactionRecordDisposition,
  SourceTransactionRecordDispositionReason,
} from "@cubby/schemas/source-transaction-record";
import { sourceTransactionRecordMatchState } from "@cubby/schemas/source-transaction-record-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import {
  type GetColumnData,
  type SQL,
  getTableColumns,
  sql,
} from "drizzle-orm";

import {
  sourceOccurrenceHasUnresolvedHistory,
  sourceHistoricalTransactionRows,
} from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceTransactionRecord } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";

/** Read projection only. Observation facts never inherit another observation's decisions. */
const sourceObservationFacts = sql`(
  -- includes-deleted: immutable observations and original aliases retain tombstone evidence.
  SELECT r.id, r.shortcode, r."batchId", r.source, r."occurrenceId", r."factFingerprint",
    r."rowPosition", r."providerTransactionId", r."providerAccountId", r."providerData",
    r."accountDescriptor", r."statementDate", r."amountMinor", r."providerAmountMinor",
    r."amountMinor"::numeric / 100 AS amount, r."providerAmountMinor"::numeric / 100 AS "providerAmount", r.merchant,
    r."rawDescription", r."sourceCategory", r."providerStatus", r."providerNotes", r."createdAt", r."deletedAt",
    own.value AS "externalId", legacy.value AS "legacyExternalId", reference.value AS "legacyReference",
    COALESCE(o.shortcode, r.shortcode) AS "chargeKey",
    CASE WHEN r."occurrenceId" IS NULL THEN a.current ELSE COALESCE(o."currentObservationId" = r.id, false) END AS current,
    CASE WHEN r."occurrenceId" IS NULL THEN a."accountId" ELSE o."accountId" END AS "accountId",
    CASE WHEN r."occurrenceId" IS NULL THEN a.disposition ELSE o.disposition END AS disposition,
    CASE WHEN r."occurrenceId" IS NULL THEN a."dispositionReason" ELSE o."dispositionReason" END AS "dispositionReason",
    CASE WHEN r."occurrenceId" IS NULL THEN a."dispositionNote" ELSE o."dispositionNote" END AS "dispositionNote",
    CASE WHEN r."occurrenceId" IS NULL THEN a."supersededByObservationId"
      WHEN o."replacementObservationId" IS NOT NULL THEN o."replacementObservationId"
      WHEN r.id <> o."currentObservationId" AND a."supersededByObservationId" = o."currentObservationId" THEN a."supersededByObservationId"
      ELSE NULL END AS "supersededByRowId",
    CASE WHEN r."occurrenceId" IS NULL THEN a."withdrawnAt" ELSE o."withdrawnAt" END AS "withdrawnAt",
    CASE WHEN r."occurrenceId" IS NULL THEN a."withdrawalImportId" ELSE o."withdrawalImportId" END AS "withdrawalImportId",
    CASE WHEN r."occurrenceId" IS NULL THEN a."lastObservedAt" ELSE o."lastObservedAt" END AS "lastObservedAt",
    CASE WHEN r."occurrenceId" IS NULL THEN a."updatedAt" ELSE greatest(a."updatedAt", o."updatedAt") END AS "updatedAt",
    a.notes, CASE WHEN o."reviewState"=${sourceOccurrenceReviewState.enum.ready} AND ${sourceOccurrenceHasUnresolvedHistory(sql`o.id`, sql`o."acceptedTransactionId"`)} THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE o."reviewState" END AS "reviewState", o.version AS "occurrenceVersion", o."acceptedTransactionId",
    ft.shortcode AS "transactionShortcode",
    ARRAY(SELECT history.code FROM (${sourceHistoricalTransactionRows(sql`r.id`, sql`ARRAY[r."occurrenceId"]::uuid[]`)}) history ORDER BY history.code) AS "historicalTransactionIds"
  FROM "SourceTransactionRecord" r
  LEFT JOIN "SourceOccurrence" o ON o.id = r."occurrenceId"
  LEFT JOIN "SourceObservationAnnotation" a ON a."observationId" = r.id
  LEFT JOIN "FinancialTransaction" ft ON ft.id = o."acceptedTransactionId" AND ${notDeleted("ft")}
  LEFT JOIN "FinancialEvidenceAlias" own ON own."observationId" = r.id AND own.kind = 'externalId'
  LEFT JOIN "FinancialEvidenceAlias" legacy ON legacy."observationId" = r.id AND legacy.kind = 'legacyExternalId'
  LEFT JOIN "FinancialEvidenceAlias" reference ON reference."observationId" = r.id AND reference.kind = 'legacyReference'
)`;

export const sourceObservations = sql`(SELECT observation.*,
  CASE WHEN observation.disposition = ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} THEN ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)}
    WHEN observation."supersededByRowId" IS NOT NULL THEN ${sourceTransactionRecordMatchState.enum.superseded}
    WHEN observation."transactionShortcode" IS NULL AND (observation."occurrenceId" IS NULL OR observation."reviewState" <> ${sourceOccurrenceReviewState.enum.ready} OR cardinality(observation."historicalTransactionIds") > 0 OR observation."acceptedTransactionId" IS NOT NULL) THEN ${sourceTransactionRecordMatchState.enum.held}
    WHEN observation."transactionShortcode" IS NOT NULL THEN ${sourceTransactionRecordMatchState.enum.matched} ELSE ${sourceTransactionRecordMatchState.enum.unmatched} END AS "matchState"
  FROM ${sourceObservationFacts} observation)`;

/** One row per explicit owner; there is no alias lookup or observation-state fold. */
export const sourceOccurrenceStates = sql`(
  SELECT o.source, o.shortcode AS "chargeKey", o.id AS "occurrenceId", CASE WHEN o."reviewState"=${sourceOccurrenceReviewState.enum.ready} AND ${sourceOccurrenceHasUnresolvedHistory(sql`o.id`, sql`o."acceptedTransactionId"`)} THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE o."reviewState" END AS "reviewState", o.version, o."acceptedTransactionId",
    o.disposition = ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} AS ignored, (o."supersededByOccurrenceId" IS NOT NULL OR o."replacementObservationId" IS NOT NULL) AS superseded,
    ft.shortcode
  FROM "SourceOccurrence" o
  LEFT JOIN "FinancialTransaction" ft ON ft.id = o."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("o")}
  UNION ALL
  SELECT r.source, r.shortcode, NULL::uuid, NULL::text, NULL::integer, NULL::uuid,
    a.disposition = ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)}, a."supersededByObservationId" IS NOT NULL, NULL::text
  FROM "SourceTransactionRecord" r
  JOIN "SourceObservationAnnotation" a ON a."observationId" = r.id
  WHERE r."occurrenceId" IS NULL AND ${notDeleted("r")}
)`;

const projected = <Value>(key: string) =>
  sql<Value>`${sql.identifier("SourceTransactionRecord")}.${sql.identifier(key)}`;
const projectedDate = (key: string) =>
  projected<Date>(key).mapWith((value: string | Date) => new Date(value));
const projectedNullableDate = (key: string) =>
  projected<Date | null>(key).mapWith((value: string | Date | null) =>
    value === null ? null : new Date(value),
  );

/** Select only from sourceObservations, never use projected fields as stored columns. */
const factColumns = getTableColumns(sourceTransactionRecord);
// SAFETY: Every key preserves its own column decoder; SQL wrappers allow selecting the same facts from a derived relation.
const projectedFacts = Object.fromEntries(
  Object.entries(factColumns).map(([key, column]) => [
    key,
    sql`${column}`.mapWith(column),
  ]),
) as {
  [K in keyof typeof factColumns]: SQL<GetColumnData<(typeof factColumns)[K]>>;
};
export const sourceObservationColumns = {
  ...projectedFacts,
  amount: projected<number>("amount").mapWith(Number),
  providerAmount: projected<number>("providerAmount").mapWith(Number),
  externalId: projected<string>("externalId"),
  legacyExternalId: projected<string | null>("legacyExternalId"),
  legacyReference: projected<string | null>("legacyReference"),
  chargeKey: projected<string>("chargeKey"),
  current: projected<boolean>("current"),
  accountId: projected<FinancialAccountId | null>("accountId"),
  disposition: projected<SourceTransactionRecordDisposition>("disposition"),
  dispositionReason: projected<SourceTransactionRecordDispositionReason | null>(
    "dispositionReason",
  ),
  dispositionNote: projected<string | null>("dispositionNote"),
  supersededByRowId: projected<SourceTransactionRecordId | null>(
    "supersededByRowId",
  ),
  withdrawnAt: projectedNullableDate("withdrawnAt"),
  withdrawalImportId: projected<TransactionImportId | null>(
    "withdrawalImportId",
  ),
  lastObservedAt: projectedDate("lastObservedAt"),
  updatedAt: projectedDate("updatedAt"),
  notes: projected<string | null>("notes"),
  acceptedTransactionId: projected<FinancialTransactionId | null>(
    "acceptedTransactionId",
  ),
  occurrenceVersion: projected<number | null>("occurrenceVersion"),
  reviewState: projected<string | null>("reviewState"),
  transactionShortcode: projected<string | null>("transactionShortcode"),
  historicalTransactionIds: projected<string[]>("historicalTransactionIds"),
  matchState: projected<
    "ignored" | "superseded" | "matched" | "held" | "unmatched"
  >("matchState"),
};

export const sourceObservationFrom = sql`${sourceObservations} "SourceTransactionRecord"`;

/** Rooted read/filter scalar; PostgreSQL prunes unused joins from the canonical projection. */
export const sourceObservationField = (
  key: keyof typeof sourceObservationColumns,
  root = "SourceTransactionRecord",
) => sql`(
  SELECT observed.${sql.identifier(key)} FROM ${sourceObservations} observed
  WHERE observed.id = ${sql.identifier(root)}.id
)`;

/** Prior member suppression is a negative fence, never proof of source or accepted identity. */
export const sourceOccurrenceSuppressed = (id: SQL) => sql`${id} IN (
  -- includes-deleted: retired aliases and occurrence reservations never release member suppression.
  WITH held_sources AS MATERIALIZED (
    SELECT held.data->>${financialTransactionSourceRef.keyof().enum.source} AS source,held.data->>'chargeKey' AS key
    FROM "Suggestion" held WHERE held.suppression IS NOT NULL AND held.family=${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    UNION
    SELECT leg.source,leg.key FROM "Suggestion" held
    CROSS JOIN LATERAL (VALUES (held.judgment#>>'{outflow,charge,source}',held.judgment#>>'{outflow,charge,chargeKey}'),
      (held.judgment#>>'{inflow,charge,source}',held.judgment#>>'{inflow,charge,chargeKey}')) leg(source,key)
    WHERE held.suppression IS NOT NULL AND held.family=${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.transfer_pair)}
  )
  SELECT alias."occurrenceId" FROM held_sources held JOIN "FinancialEvidenceAlias" alias
    ON alias.source=held.source AND alias.value=held.key AND alias."observationId" IS NOT NULL WHERE alias."occurrenceId" IS NOT NULL
  UNION
  SELECT owner.id FROM held_sources held JOIN "SourceOccurrence" owner ON owner.source=held.source AND owner.shortcode=held.key
)`;

export const SOURCE_HELD_REASON =
  "Source identity or historical ownership needs an explicit review. Retained advice and member decisions are unchanged; money stays unchanged until reviewed.";

/** Held advice can be dismissed, but cannot suppress a later proven occurrence. */
export const statementSuggestionSourceHeld = (alias: string) => sql`NOT EXISTS (
  SELECT 1 FROM ${sourceObservations} reviewed
  WHERE reviewed.id=${sql.identifier(alias)}."recordId" AND reviewed."occurrenceId" IS NOT NULL
    AND reviewed.current AND reviewed."reviewState"=${sourceOccurrenceReviewState.enum.ready}
    AND reviewed."withdrawnAt" IS NULL AND reviewed."supersededByRowId" IS NULL
    AND reviewed."chargeKey"=${sql.identifier(alias)}.data->>'chargeKey'
)`;
