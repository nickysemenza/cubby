import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { type SQL, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";

import {
  sourceObservations,
  sourceOccurrenceStates,
} from "./source-observation-state";

/** Accepted ownership is the occurrence FK; external strings never resolve an owner. */
export const LIVE_REFS = sql`(
  SELECT o.source, o.shortcode AS "externalId", ft.shortcode
  FROM "SourceOccurrence" o
  JOIN "FinancialTransaction" ft ON ft.id = o."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("o")}
)`;

/**
 * Explicit source-record identity. Historical reference strings remain links;
 * equal descriptions and amounts alone do not establish charge equivalence.
 */
export const chargeKeyOf = (alias: string) => sql.raw(`${alias}."chargeKey"`);

/** Scoped direct state, with one row per owner and no observation-state aggregation. */
export const chargeStateOf = (scope: SQL) => sql`(
  SELECT state.* FROM ${sourceOccurrenceStates} state
  WHERE EXISTS (SELECT 1 FROM ${sourceObservations} r
    WHERE r.source = state.source AND r."chargeKey" = state."chargeKey"
      AND ${notDeleted("r")} AND (${scope}))
)`;

export const CHARGE_STATE = chargeStateOf(sql`true`);

export const OCCURRENCE_IDENTITY_REVIEW =
  "This observation has no ready, proven source occurrence. Automatic financial actions remain blocked; retain its evidence and money unchanged.";

/** Membership and equal bank facts cannot establish an independent occurrence. */
export function hasStatementOccurrence(row: {
  occurrenceId: string | null;
  reviewState: string | null;
}): boolean {
  return row.occurrenceId !== null && row.reviewState === "ready";
}

/** Settlement-ref keys stored on a suggestion's projection, `source:externalId`. */
export const suggestionRefKey = (source: string, externalId: string) =>
  `${source}:${externalId}`;

/** A projection field of a statement suggestion's row. */
export const suggestionField = (
  key:
    | "source"
    | "chargeKey"
    | "accountId"
    | "month"
    | "statementDate"
    | "amount"
    | "recommended"
    | "clean"
    | "evidenceFingerprint"
    | "needsLabel",
  alias = "s",
) => sql`${sql.raw(`"${alias}"`)}.data->>${key}`;

/**
 * Current unsettled evidence gates reads as well as discovery. Schema-owned
 * family/status literals preserve partial-index admission in generic plans;
 * caller values remain parameters. No retirement scan is required.
 * Account-scoped readers use indexed probes and short-circuit on eligibility.
 */
export const pendingSuggestion = (alias = "s") =>
  sql`${sql.raw(`"${alias}"`)}.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    AND ${sql.raw(`"${alias}"`)}.active
    AND ${sql.raw(`"${alias}"`)}.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
    AND EXISTS (SELECT 1 FROM "SourceOccurrence" occurrence
      JOIN ${sourceObservations} head ON head.id = occurrence."currentObservationId"
      WHERE occurrence.source = ${suggestionField("source", alias)}
        AND occurrence.shortcode = ${suggestionField("chargeKey", alias)}
        AND occurrence."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
        AND ${notDeleted("occurrence")} AND ${notDeleted("head")}
        AND occurrence.disposition <> ${sourceTransactionRecordDisposition.enum.ignored}
        AND occurrence."supersededByOccurrenceId" IS NULL
        AND occurrence."replacementObservationId" IS NULL
        AND head."externalId" = ${sql.raw(`"${alias}"`)}.data->>'headRef'
        AND (occurrence."withdrawnAt" IS NULL OR ${sql.raw(`"${alias}"`)}.data->>'reviewReason' IS NOT NULL)
        AND (occurrence."acceptedTransactionId" IS NULL OR ${sql.raw(`"${alias}"`)}.data->>'recommended' IN (${statementTransactionAction.enum.void}, ${statementTransactionAction.enum.book})))`;
