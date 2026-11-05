import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

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
