import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/** Observations reach their accepted transaction through the single occurrence owner. */
export const sourceTransactionSettlements = sql`SELECT record.id AS "record", ft.id AS "transaction"
  FROM "SourceTransactionRecord" record
  JOIN "SourceOccurrence" occurrence ON occurrence.id = record."occurrenceId"
  JOIN "FinancialTransaction" ft ON ft.id = occurrence."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("record")}
  UNION
  -- Historical connections explain retained bindings; never use this read projection to accept ownership.
  SELECT record.id, historical.id FROM "SourceTransactionRecord" record
  JOIN "FinancialEvidenceAlias" observed ON (observed."observationId"=record.id OR (record."occurrenceId" IS NOT NULL AND observed."occurrenceId"=record."occurrenceId"))
  JOIN "FinancialEvidenceAlias" binding ON binding.source=observed.source AND binding.value=observed.value
  JOIN "FinancialTransaction" historical ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}
  WHERE ${notDeleted("record")}`;
