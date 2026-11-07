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
  sourceOccurrencesWithUnresolvedHistory,
  sourceObservationHistoricalLinks,
  sourcePageHistory,
} from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { sourceTransactionRecord } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";

/** Read projection only. Observation facts never inherit another observation's decisions. */
export const sourceObservationFacts = sql`(
  -- includes-deleted: immutable observations and original aliases retain tombstone evidence.
  SELECT r.id, r.shortcode, r."batchId", r.source, r."occurrenceId", r."factFingerprint",
    r."rowPosition", r."providerTransactionId", r."providerAccountId", r."providerData",
    r."accountDescriptor", r."statementDate", r."amountMinor", r."providerAmountMinor",
    r."amountMinor"::numeric / 100 AS amount, r."providerAmountMinor"::numeric / 100 AS "providerAmount", r.merchant,
    r."rawDescription", r."sourceCategory", r."providerStatus", r."providerNotes", r."createdAt", r."deletedAt",
    own.value AS "externalId", legacy.value AS "legacyExternalId", reference.value AS "legacyReference",
    o.shortcode AS "chargeKey",
    COALESCE(o."currentObservationId" = r.id, false) AS current,
    o."accountId" AS "accountId",
    o.disposition AS disposition,
    o."dispositionReason" AS "dispositionReason",
    o."dispositionNote" AS "dispositionNote",
    CASE WHEN o."replacementObservationId" IS NOT NULL THEN o."replacementObservationId"
      WHEN r.id <> o."currentObservationId" AND a."supersededByObservationId" = o."currentObservationId" THEN a."supersededByObservationId"
      ELSE NULL END AS "supersededByRowId",
    o."withdrawnAt" AS "withdrawnAt",
    o."withdrawalImportId" AS "withdrawalImportId",
    o."lastObservedAt" AS "lastObservedAt",
    greatest(a."updatedAt", o."updatedAt") AS "updatedAt",
    a.notes, o."reviewState" AS "storedReviewState", o.version AS "occurrenceVersion", o."acceptedTransactionId",
    ft.shortcode AS "transactionShortcode"
  FROM "SourceTransactionRecord" r
  JOIN "SourceOccurrence" o ON o.id = r."occurrenceId"
  LEFT JOIN "SourceObservationAnnotation" a ON a."observationId" = r.id
  LEFT JOIN "FinancialTransaction" ft ON ft.id = o."acceptedTransactionId" AND ${notDeleted("ft")}
  LEFT JOIN "FinancialEvidenceAlias" own ON own."observationId" = r.id AND own.kind = 'externalId'
  LEFT JOIN "FinancialEvidenceAlias" legacy ON legacy."observationId" = r.id AND legacy.kind = 'legacyExternalId'
  LEFT JOIN "FinancialEvidenceAlias" reference ON reference."observationId" = r.id AND reference.kind = 'legacyReference'
)`;

/** Identity and immutable facts only: no annotation, alias-history or accepted-money projection. */
export const sourceObservationIdentities = sql`(
  -- includes-deleted: physical memberships and reserved identities retain tombstone evidence.
  SELECT r.*, o.shortcode AS "chargeKey"
  FROM "SourceTransactionRecord" r JOIN "SourceOccurrence" o ON o.id=r."occurrenceId"
)`;

const sourceObservationRead = (
  observationIds?: readonly SourceTransactionRecordId[],
) => {
  const history =
    observationIds === undefined
      ? {
          relations: sql``,
          unresolved: sourceOccurrencesWithUnresolvedHistory,
          links: sourceObservationHistoricalLinks,
        }
      : sourcePageHistory(observationIds);
  return sql`(${history.relations} SELECT observation.*,
  CASE WHEN observation.disposition = ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} THEN ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)}
    WHEN observation."supersededByRowId" IS NOT NULL THEN ${sourceTransactionRecordMatchState.enum.superseded}
    WHEN observation."transactionShortcode" IS NULL AND (observation."reviewState" <> ${sourceOccurrenceReviewState.enum.ready} OR cardinality(observation."historicalTransactionIds") > 0 OR observation."acceptedTransactionId" IS NOT NULL) THEN ${sourceTransactionRecordMatchState.enum.held}
    WHEN observation."transactionShortcode" IS NOT NULL THEN ${sourceTransactionRecordMatchState.enum.matched} ELSE ${sourceTransactionRecordMatchState.enum.unmatched} END AS "matchState"
  FROM (
    SELECT facts.*,
      CASE WHEN facts."storedReviewState"=${sourceOccurrenceReviewState.enum.ready} AND unresolved.id IS NOT NULL
        THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE facts."storedReviewState" END AS "reviewState",
      coalesce(history.codes, ARRAY[]::text[]) AS "historicalTransactionIds"
    FROM ${sourceObservationFacts} facts
    LEFT JOIN ${history.unresolved} unresolved ON unresolved.id=facts."occurrenceId"
    LEFT JOIN ${history.links} history ON history."observationId"=facts.id
    ${observationIds === undefined ? sql`` : sql`WHERE facts.id=ANY(${uuidArrayParam(observationIds)})`}
  ) observation)`;
};

export const sourceObservations = sourceObservationRead();

/** Page states share the global policy but expand history only for their roots. */
export const sourceObservationsForPage = (
  observationIds: readonly SourceTransactionRecordId[],
): SQL => sourceObservationRead(observationIds);

/** Hash the complete negative fence once; never re-run history closure for each suggestion. */
export const sourceReadyOccurrenceIds = sql`-- includes-deleted: reserved ownership and stored review state remain binding after tombstoning.
  SELECT ready.id FROM "SourceOccurrence" ready
  WHERE ready."reviewState"=${sourceOccurrenceReviewState.enum.ready}
    AND ready.id NOT IN (SELECT id FROM ${sourceOccurrencesWithUnresolvedHistory} unresolved)`;

/** One row per explicit owner; there is no alias lookup or observation-state fold. */
export const sourceOccurrenceStates = sql`(
  SELECT o.source, o.shortcode AS "chargeKey", o.id AS "occurrenceId", CASE WHEN o."reviewState"=${sourceOccurrenceReviewState.enum.ready} AND unresolved.id IS NOT NULL THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE o."reviewState" END AS "reviewState", o.version, o."acceptedTransactionId",
    o.disposition = ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} AS ignored, (o."supersededByOccurrenceId" IS NOT NULL OR o."replacementObservationId" IS NOT NULL) AS superseded,
    ft.shortcode
  FROM "SourceOccurrence" o
  LEFT JOIN ${sourceOccurrencesWithUnresolvedHistory} unresolved ON unresolved.id=o.id
  LEFT JOIN "FinancialTransaction" ft ON ft.id = o."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("o")}
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

/** Whole-list membership stays uncorrelated, including when used as a sort key. */
export const sourceObservationField = (
  key: keyof typeof sourceObservationColumns,
  root = "SourceTransactionRecord",
): SQL => {
  const id = sql`${sql.identifier(root)}.id`;
  if (key === "matchState") {
    return sql`CASE ${sql.join(
      sourceTransactionRecordMatchState.options.map(
        (state) =>
          sql`WHEN ${id} IN (SELECT observed.id FROM ${sourceObservations} observed WHERE observed."matchState"=${state}) THEN ${state}`,
      ),
      sql` `,
    )} END`;
  }
  if (key === "reviewState") {
    // The point helper owns an inner "owner" alias; keep its root distinct.
    return sql`(SELECT CASE WHEN point_owner."reviewState"=${sourceOccurrenceReviewState.enum.ready}
      AND ${sourceOccurrenceHasUnresolvedHistory(sql`point_owner.id`, sql`point_owner."acceptedTransactionId"`)}
      THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE point_owner."reviewState" END
      FROM "SourceOccurrence" point_owner JOIN "SourceTransactionRecord" record ON record."occurrenceId"=point_owner.id WHERE record.id=${id})`;
  }
  return sql`(SELECT observed.${sql.identifier(key)} FROM ${key === "historicalTransactionIds" ? sourceObservations : sourceObservationFacts} observed WHERE observed.id=${id})`;
};

export const SOURCE_HELD_REASON =
  "Source identity or historical ownership needs an explicit review. Retained advice and member decisions are unchanged; money stays unchanged until reviewed.";

/** Held advice can be dismissed, but cannot suppress a later proven occurrence. */
export const statementSuggestionSourceHeld = (alias: string) => sql`NOT EXISTS (
  SELECT 1 FROM ${sourceObservationFacts} reviewed
  WHERE reviewed.id=${sql.identifier(alias)}."recordId" AND reviewed."occurrenceId" IS NOT NULL
    AND reviewed.current AND reviewed."occurrenceId" IN (${sourceReadyOccurrenceIds})
    AND reviewed."withdrawnAt" IS NULL AND reviewed."supersededByRowId" IS NULL
    AND reviewed."chargeKey"=${sql.identifier(alias)}.data->>'chargeKey'
)`;
