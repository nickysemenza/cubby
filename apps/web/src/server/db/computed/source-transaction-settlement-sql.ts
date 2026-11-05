import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/** Observations reach their accepted transaction through the single occurrence owner. */
export const sourceTransactionSettlements = sql`SELECT record.id AS "record", ft.id AS "transaction"
  FROM "SourceTransactionRecord" record
  JOIN "SourceOccurrence" occurrence ON occurrence.id = record."occurrenceId"
  JOIN "FinancialTransaction" ft ON ft.id = occurrence."acceptedTransactionId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("record")}`;
