import { suggestionStatus } from "@cubby/schemas/ai";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record";
import {
  statementTransactionAction,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { cents } from "@cubby/shared";
import { type SQL, sql } from "drizzle-orm";

import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  sourceObservationFacts,
  sourceOccurrenceStates,
  sourceOccurrenceStatesWhere,
} from "~/server/domains/transaction-import/repo/source-observation-state";

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
export const chargeStateOf = (scope: SQL) =>
  sourceOccurrenceStatesWhere(sql`EXISTS (SELECT 1 FROM ${sourceObservationFacts} r
    WHERE r.source = o.source AND r."chargeKey" = o.shortcode
      AND ${notDeleted("r")} AND (${scope}))`);

export const CHARGE_STATE = sql`(
  SELECT state.* FROM ${sourceOccurrenceStates} state
  WHERE EXISTS (SELECT 1 FROM ${sourceObservationFacts} r
    WHERE r.source = state.source AND r."chargeKey" = state."chargeKey"
      AND ${notDeleted("r")})
)`;

export const OCCURRENCE_IDENTITY_REVIEW =
  "This observation has no ready, proven source occurrence. Automatic financial actions remain blocked; retain its evidence and money unchanged.";

/**
 * Book a matched charge, supersede a hold, attach only to a candidate that can
 * take this charge, otherwise create. A context candidate (settled elsewhere,
 * wrong sign or amount) never earns attach, and neither does one the model is
 * confident is a different charge at a different amount. Candidates stay
 * listed and attachable either way.
 */
export function statementRecommendation(
  judgment: Pick<
    StatementTransactionJudgment,
    "candidates" | "matchedTransactionId"
  > & {
    supersede: unknown;
    create: Pick<
      NonNullable<StatementTransactionJudgment["create"]>,
      "amount"
    > | null;
    recommended?: StatementTransactionJudgment["recommended"];
  },
): StatementTransactionJudgment["recommended"] {
  if (judgment.recommended === "void") return "void";
  if (judgment.matchedTransactionId) return "book";
  if (judgment.supersede) return "supersede";
  const amount = judgment.create ? cents(judgment.create.amount) : null;
  return judgment.candidates.some(
    (candidate) =>
      candidate.eligibility !== "context" &&
      !(
        cents(candidate.amount) !== amount &&
        candidate.label?.same === "different" &&
        candidate.label.confidence === "high"
      ),
  )
    ? "attach"
    : "create";
}

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
) => sql`${sql.raw(`"${alias}"`)}.data->>${sql.raw(`'${key}'`)}`;

/**
 * Current unsettled evidence gates reads as well as discovery. Schema-owned
 * family/status literals preserve partial-index admission in generic plans;
 * caller values remain parameters. No retirement scan is required.
 * Account-scoped readers use indexed probes and short-circuit on eligibility.
 */
export const pendingSuggestion = (alias = "s") =>
  sql`${sql.raw(`"${alias}"`)}.family = ${sqlEnumConstant(suggestionFamily, suggestionFamily.enum.statement_transaction)}
    AND ${sql.raw(`"${alias}"`)}.active
    AND ${sql.raw(`"${alias}"`)}.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
    AND EXISTS (SELECT 1 FROM ${sourceObservationFacts} observation
      WHERE observation.id=${sql.raw(`"${alias}"`)}."recordId" AND ${notDeleted("observation")}
        AND observation.disposition <> ${sourceTransactionRecordDisposition.enum.ignored}
        AND observation."supersededByRowId" IS NULL
        AND (observation."acceptedTransactionId" IS NULL OR ${sql.raw(`"${alias}"`)}.data->>'recommended' IN (${statementTransactionAction.enum.void}, ${statementTransactionAction.enum.book})))`;

/** Retained review can remain visible while automatic work requires current proven authority. */
export const sourceSuggestionAutomaticEligible = (
  alias = "s",
  allowRetainedCorrection = false,
) => sql`-- includes-deleted: retained occurrences continue to fence source eligibility.
EXISTS (
  SELECT 1 FROM ${sourceObservationFacts} observed
  WHERE observed.id=${sql.identifier(alias)}."recordId" AND ${notDeleted("observed")}
    -- includes-deleted: retained ownership remains binding.
    AND EXISTS (SELECT 1 FROM "SourceOccurrence" point_owner
      WHERE point_owner.id=observed."occurrenceId" AND point_owner."reviewState"=${sourceOccurrenceReviewState.enum.ready}
        AND NOT ${sourceOccurrenceHasUnresolvedHistory(sql`point_owner.id`, sql`point_owner."acceptedTransactionId"`)})
    AND observed.current AND observed.disposition <> ${sourceTransactionRecordDisposition.enum.ignored} AND observed."supersededByRowId" IS NULL
    AND observed."chargeKey"=${sql.identifier(alias)}.data->>'chargeKey'
    AND (observed."withdrawnAt" IS NULL OR ${allowRetainedCorrection ? sql`${sql.identifier(alias)}.data->>'reviewReason' IS NOT NULL` : sql`${sql.identifier(alias)}.data->>'recommended'=${statementTransactionAction.enum.void}`})
)`;
