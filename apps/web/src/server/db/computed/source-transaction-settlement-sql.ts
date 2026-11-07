import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

const liveHistoricalTransaction = sql`JOIN "FinancialTransaction" historical
  ON historical.id=binding."historicalTransactionId" AND ${notDeleted("historical")}`;

function settlementRows(recordIds?: SQL): SQL {
  const roots = recordIds ? sql`AND record.id IN (${recordIds})` : sql``;
  // Share historical bindings before joining page aliases: otherwise each key
  // can repeatedly scan the alias index whose middle column is kind.
  const history = recordIds
    ? sql`WITH source_settlement_history AS MATERIALIZED (
        -- includes-deleted: retained binding aliases still explain history.
        SELECT binding.source, binding.value, historical.id
        FROM "FinancialEvidenceAlias" binding ${liveHistoricalTransaction}
      )`
    : sql``;
  const historical = recordIds
    ? sql`JOIN source_settlement_history historical
        ON historical.source=observed.source AND historical.value=observed.value`
    : sql`JOIN "FinancialEvidenceAlias" binding ON binding.source=observed.source AND binding.value=observed.value
        ${liveHistoricalTransaction}`;
  return sql`${history}
  SELECT record.id AS "record", ft.id AS "transaction"
  FROM "SourceTransactionRecord" record
  JOIN "SourceOccurrence" occurrence ON occurrence.id = record."occurrenceId"
  JOIN "FinancialTransaction" ft ON ft.id = occurrence."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("record")} ${roots}
  UNION
  -- includes-deleted: retained observation and binding aliases explain history, never accepted ownership.
  SELECT record.id, historical.id FROM "SourceTransactionRecord" record
  JOIN "FinancialEvidenceAlias" observed ON (observed."observationId"=record.id OR observed."occurrenceId"=record."occurrenceId")
  ${historical}
  WHERE ${notDeleted("record")} ${roots}`;
}

/** Observations reach their accepted transaction through the single occurrence owner. */
export const sourceTransactionSettlements = settlementRows();

/** Restrict roots only; their complete historical evidence remains available. */
export const sourceTransactionSettlementsForRecords = (recordIds: SQL): SQL =>
  settlementRows(recordIds);
