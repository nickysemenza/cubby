import { sql } from "drizzle-orm";

/** First ownership remains membership proof, including writes during rollout. */
export const statementImportMembers = sql`(
  SELECT "batchId" AS "importId", id AS "statementRowId" FROM "StatementRow"
  UNION
  SELECT "importId", "statementRowId" FROM "StatementImportRow"
)`;
