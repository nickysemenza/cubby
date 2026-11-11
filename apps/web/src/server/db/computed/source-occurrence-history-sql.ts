import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";

const unresolvedOwnership = (
  historicalId: SQL,
  acceptedId: SQL,
  proof: SQL,
) => sql`
  ${historicalId} IS DISTINCT FROM ${acceptedId}
  AND NOT COALESCE(${proof}->'resolvedHistoricalTransactionIds' ? ${historicalId}::text,false)`;

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
    AND ${unresolvedOwnership(sql`binding."historicalTransactionId"`, acceptedId, sql`owner."identityProof"`)}
)`;

// occurrenceIds is already a SQL array expression, not an interpolated JavaScript array.
/* oxlint-disable anti-slop/no-unsafe-sql-array-interpolation */
/** Presentation/review closure includes weakly related sibling history, never accepted ownership. */
export const sourceHistoricalTransactionRows = (
  observationId: SQL,
  occurrenceIds: SQL,
) => sql`
  SELECT DISTINCT historical.id, historical.shortcode AS code
  FROM "FinancialEvidenceAlias" observed
  JOIN "FinancialEvidenceAlias" sibling ON sibling.source=observed.source AND sibling.value=observed.value AND sibling."observationId" IS NOT NULL
  JOIN LATERAL (
    SELECT source, value FROM "FinancialEvidenceAlias" WHERE "observationId"=sibling."observationId"
    UNION ALL
    SELECT source, value FROM "FinancialEvidenceAlias" WHERE "occurrenceId"=sibling."occurrenceId"
  ) evidence ON true
  JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}
  WHERE observed."observationId"=${observationId} OR observed."occurrenceId" = ANY(${occurrenceIds})`;

/* oxlint-enable anti-slop/no-unsafe-sql-array-interpolation */

/** Live binding edges, materialized before sibling expansion by the read projection. */
const directHistoricalEvidence = sql`
  SELECT DISTINCT evidence."observationId", evidence."occurrenceId",
    binding."historicalTransactionId", historical.shortcode AS code
  FROM "FinancialEvidenceAlias" evidence
  JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}`;

/** Global and page reads apply the same negative ownership predicate. */
const unresolvedFrom = (evidence: SQL): SQL => sql`(
  SELECT DISTINCT owner.id
  FROM (${evidence}) evidence
  JOIN "SourceOccurrence" owner ON owner.id=evidence."occurrenceId"
  WHERE owner."reviewState"=${sourceOccurrenceReviewState.enum.ready}
    AND ${unresolvedOwnership(sql`evidence."historicalTransactionId"`, sql`owner."acceptedTransactionId"`, sql`owner."identityProof"`)}
)`;

/** Same negative ownership fence as the point check, evaluated once for a read. */
export const sourceOccurrencesWithUnresolvedHistory = unresolvedFrom(
  directHistoricalEvidence,
);

/** Whole-list history retains all roots and all sibling evidence. */
export const sourceObservationHistoricalLinks = sql`(
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
    UNION
    SELECT record.id, observed.source, observed.value
    FROM "SourceTransactionRecord" record
    JOIN "FinancialEvidenceAlias" observed ON observed."occurrenceId"=record."occurrenceId"
    JOIN history_keys keys ON keys.source=observed.source AND keys.value=observed.value
  ),
  history AS MATERIALIZED (
    SELECT DISTINCT observed."observationId", history."historicalTransactionId", history.code
    FROM observation_keys observed JOIN key_history history ON history.source=observed.source AND history.value=observed.value
  )
  SELECT "observationId", array_agg(code ORDER BY code) AS codes
  FROM history GROUP BY "observationId"
)`;

/** The fragments share CTE scope and must be emitted in one statement. */
interface SourcePageHistory {
  readonly relations: SQL;
  readonly unresolved: SQL;
  readonly links: SQL;
}

/** Reach one sibling hop from the page; the occurrence fence stays direct.
 * Unlike settlement media, these reads must exclude tombstoned bindings. */
export const sourcePageHistory = (
  observationIds: readonly SourceTransactionRecordId[],
): SourcePageHistory => ({
  relations: sql`WITH source_page AS MATERIALIZED (
    -- includes-deleted: requested roots and alias bridges preserve retained historical evidence.
    SELECT id, "occurrenceId" FROM "SourceTransactionRecord"
    WHERE id=ANY(${uuidArrayParam(observationIds)})
  ), source_page_keys AS MATERIALIZED (
    SELECT page.id AS root, observed.source, observed.value
    FROM source_page page JOIN "FinancialEvidenceAlias" observed ON observed."observationId"=page.id
    UNION
    SELECT page.id, observed.source, observed.value
    FROM source_page page JOIN "FinancialEvidenceAlias" observed ON observed."occurrenceId"=page."occurrenceId"
  ), source_siblings AS MATERIALIZED (
    SELECT DISTINCT sibling.source, sibling.value, sibling."observationId", sibling."occurrenceId"
    FROM "FinancialEvidenceAlias" sibling
    JOIN (SELECT DISTINCT source, value FROM source_page_keys) keys ON keys.source=sibling.source AND keys.value=sibling.value
    WHERE sibling."observationId" IS NOT NULL
  ), source_evidence AS MATERIALIZED (
    SELECT evidence.source, evidence.value, evidence."observationId", evidence."occurrenceId"
    FROM "FinancialEvidenceAlias" evidence
    JOIN (SELECT DISTINCT "observationId" FROM source_siblings) sibling ON evidence."observationId"=sibling."observationId"
    UNION
    SELECT evidence.source, evidence.value, evidence."observationId", evidence."occurrenceId"
    FROM "FinancialEvidenceAlias" evidence
    JOIN (SELECT DISTINCT "occurrenceId" FROM source_siblings WHERE "occurrenceId" IS NOT NULL) sibling ON evidence."occurrenceId"=sibling."occurrenceId"
  ), source_live_bindings AS MATERIALIZED (
    SELECT DISTINCT binding.source, binding.value, binding."historicalTransactionId", historical.shortcode AS code
    FROM (
      SELECT source, value FROM source_evidence
      UNION
      SELECT evidence.source, evidence.value FROM "FinancialEvidenceAlias" evidence
      JOIN source_page page ON evidence."occurrenceId"=page."occurrenceId"
    ) keys
    JOIN "FinancialEvidenceAlias" binding ON binding.source=keys.source AND binding.value=keys.value
    JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}
    WHERE ${notDeleted("binding")} AND binding."historicalTransactionId" IS NOT NULL
  ), source_evidence_history AS MATERIALIZED (
    SELECT DISTINCT evidence."observationId", evidence."occurrenceId", binding."historicalTransactionId", binding.code
    FROM source_evidence evidence JOIN source_live_bindings binding ON binding.source=evidence.source AND binding.value=evidence.value
  ), source_key_history AS MATERIALIZED (
    -- includes-deleted: retained alias tombstones remain presentation bridges.
    -- Keep owner-index access here; a materialized sibling map loses it for hub keys.
    SELECT sibling.source, sibling.value, evidence."historicalTransactionId", evidence.code
    FROM "FinancialEvidenceAlias" sibling JOIN source_evidence_history evidence ON evidence."observationId"=sibling."observationId"
    WHERE sibling."observationId" IS NOT NULL AND (sibling.source, sibling.value) IN (SELECT source, value FROM source_page_keys)
    UNION
    SELECT sibling.source, sibling.value, evidence."historicalTransactionId", evidence.code
    FROM "FinancialEvidenceAlias" sibling JOIN source_evidence_history evidence ON evidence."occurrenceId"=sibling."occurrenceId"
    WHERE sibling."observationId" IS NOT NULL AND sibling."occurrenceId" IS NOT NULL
      AND (sibling.source, sibling.value) IN (SELECT source, value FROM source_page_keys)
  )`,
  // A fence-only occurrence need not have an observation sibling on its key.
  unresolved: unresolvedFrom(sql`
    SELECT DISTINCT evidence."occurrenceId", binding."historicalTransactionId"
    FROM "FinancialEvidenceAlias" evidence
    JOIN source_live_bindings binding ON binding.source=evidence.source AND binding.value=evidence.value
    WHERE evidence."occurrenceId" IN (SELECT "occurrenceId" FROM source_page)
  `),
  links: sql`(
    SELECT history.root AS "observationId", array_agg(history.code ORDER BY history.code) AS codes
    FROM (
      SELECT DISTINCT keys.root, history."historicalTransactionId", history.code
      FROM source_page_keys keys JOIN source_key_history history ON history.source=keys.source AND history.value=keys.value
    ) history GROUP BY history.root
  )`,
});
