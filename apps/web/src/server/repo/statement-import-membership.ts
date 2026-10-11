import { sql } from "drizzle-orm";

/** First ownership remains membership proof, including writes during rollout.
 * includes-deleted: retired import bookkeeping retains coexistence evidence;
 * consumers separately exclude deleted statement rows from live coverage. */
export const statementImportMembers = sql`(
  SELECT "batchId" AS "importId", id AS "statementRowId" FROM "StatementRow"
  UNION
  SELECT "importId", "statementRowId" FROM "StatementImportRow"
)`;
