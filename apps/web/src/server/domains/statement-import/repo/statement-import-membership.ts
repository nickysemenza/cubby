import { sql } from "drizzle-orm";

/** First ownership remains membership proof, including writes during rollout.
 * includes-deleted: retired import bookkeeping retains coexistence evidence;
 * consumers separately exclude deleted statement rows from live coverage.
 * Each arm is already unique (row id; the import/row key), so excluding the
 * first-batch pairs from the second arm yields UNION's set without a global
 * deduplication over every statement row. */
export const statementImportMembers = sql`(
  SELECT "batchId" AS "importId", id AS "statementRowId" FROM "StatementRow"
  UNION ALL
  SELECT later."importId", later."statementRowId" FROM "StatementImportRow" later
  -- includes-deleted: the first arm above keeps deleted rows' ownership too.
  WHERE NOT EXISTS (
    SELECT 1 FROM "StatementRow" first_batch
    WHERE first_batch.id = later."statementRowId" AND first_batch."batchId" = later."importId"
  )
)`;
