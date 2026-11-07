import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";

/** Historical bindings block automatic acceptance; they never establish the owner. */
export const sourceOccurrenceHasUnresolvedHistory = (
  id: SQL,
  acceptedId: SQL,
) =>
  // includes-deleted: retained aliases and owner reservations fence unresolved historical acceptance.
  sql`EXISTS (
  SELECT 1 FROM "FinancialEvidenceAlias" observed
  JOIN "FinancialEvidenceAlias" binding ON binding.source=observed.source AND binding.value=observed.value
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}
  JOIN "SourceOccurrence" owner ON owner.id=observed."occurrenceId"
  WHERE observed."occurrenceId"=${id} AND ${notDeleted("binding")}
    AND binding."historicalTransactionId" IS DISTINCT FROM ${acceptedId}
    AND NOT COALESCE(owner."identityProof"->'resolvedHistoricalTransactionIds' ? binding."historicalTransactionId"::text,false)
)`;

/** Presentation/review closure includes weakly related sibling history, never accepted ownership. */
export const sourceHistoricalTransactionRows = (
  observationId: SQL,
  occurrenceIds: SQL,
) => sql`
  SELECT DISTINCT historical.id, historical.shortcode AS code
  FROM "FinancialEvidenceAlias" observed
  JOIN "FinancialEvidenceAlias" sibling ON sibling.source=observed.source AND sibling.value=observed.value AND sibling."observationId" IS NOT NULL
  JOIN "FinancialEvidenceAlias" evidence ON evidence."observationId"=sibling."observationId" OR (sibling."occurrenceId" IS NOT NULL AND evidence."occurrenceId"=sibling."occurrenceId")
  JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}
  WHERE observed."observationId"=${observationId} OR observed."occurrenceId" IN (SELECT unnest(${occurrenceIds}))`;

/** Live binding edges, materialized before sibling expansion by the read projection. */
const directHistoricalEvidence = sql`
  SELECT DISTINCT evidence."observationId", evidence."occurrenceId",
    binding."historicalTransactionId", historical.shortcode AS code
  FROM "FinancialEvidenceAlias" evidence
  JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}`;

/** Same negative ownership fence as the point check, evaluated once for a read. */
export const sourceOccurrencesWithUnresolvedHistory = sql`(
  SELECT DISTINCT owner.id
  FROM (${directHistoricalEvidence}) evidence
  JOIN "SourceOccurrence" owner ON owner.id=evidence."occurrenceId"
  WHERE owner."reviewState"=${sourceOccurrenceReviewState.enum.ready}
    AND evidence."historicalTransactionId" IS DISTINCT FROM owner."acceptedTransactionId"
    AND NOT COALESCE(owner."identityProof"->'resolvedHistoricalTransactionIds' ? evidence."historicalTransactionId"::text,false)
)`;

/** Page scope limits final roots, never the sibling evidence or ownership fence. */
export const sourceObservationHistoricalLinks = (
  observationIds?: readonly SourceTransactionRecordId[],
) => sql`(
  WITH evidence_history AS MATERIALIZED (${directHistoricalEvidence}),
  key_history AS MATERIALIZED (
    SELECT sibling.source, sibling.value, evidence."historicalTransactionId", evidence.code
    FROM "FinancialEvidenceAlias" sibling
    JOIN evidence_history evidence ON evidence."observationId"=sibling."observationId"
    WHERE sibling."observationId" IS NOT NULL
    UNION
    SELECT sibling.source, sibling.value, evidence."historicalTransactionId", evidence.code
    FROM "FinancialEvidenceAlias" sibling
    JOIN evidence_history evidence ON evidence."occurrenceId"=sibling."occurrenceId"
    WHERE sibling."observationId" IS NOT NULL AND sibling."occurrenceId" IS NOT NULL
  ),
  history_keys AS MATERIALIZED (
    SELECT DISTINCT source, value FROM key_history
  ),
  observation_keys AS MATERIALIZED (
    -- includes-deleted: retained alias tombstones stay in presentation history; map keys before expansion.
    SELECT observed."observationId", observed.source, observed.value
    FROM "FinancialEvidenceAlias" observed
    JOIN history_keys keys ON keys.source=observed.source AND keys.value=observed.value
    WHERE observed."observationId" IS NOT NULL
      ${observationIds === undefined ? sql`` : sql`AND observed."observationId"=ANY(${uuidArrayParam(observationIds)})`}
    UNION
    SELECT record.id, observed.source, observed.value
    FROM "SourceTransactionRecord" record
    JOIN "FinancialEvidenceAlias" observed ON observed."occurrenceId"=record."occurrenceId"
    JOIN history_keys keys ON keys.source=observed.source AND keys.value=observed.value
    ${observationIds === undefined ? sql`` : sql`WHERE record.id=ANY(${uuidArrayParam(observationIds)})`}
  ),
  history AS MATERIALIZED (
    SELECT DISTINCT observed."observationId", history."historicalTransactionId", history.code
    FROM observation_keys observed JOIN key_history history ON history.source=observed.source AND history.value=observed.value
  )
  SELECT "observationId", array_agg(code ORDER BY code) AS codes
  FROM history GROUP BY "observationId"
)`;
