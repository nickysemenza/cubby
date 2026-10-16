import { sql } from "drizzle-orm";

/** First ownership remains membership proof, including writes during rollout.
 * Primary ownership contributes each row once; unique import/row pairs add only
 * other exports, keeping UNION ALL duplicate-free without global deduplication.
 * includes-deleted: retired import bookkeeping retains coexistence evidence;
 * consumers separately exclude deleted statement rows from live coverage. */
export const statementImportMembers = sql`(
  SELECT "batchId" AS "importId", id AS "statementRowId" FROM "StatementRow"
  UNION ALL
  SELECT membership."importId", membership."statementRowId"
  FROM "StatementImportRow" membership
  JOIN "StatementRow" first_owner ON first_owner.id = membership."statementRowId"
  WHERE first_owner."batchId" <> membership."importId"
)`;
