import { sql } from "drizzle-orm";

/** Retained collection membership includes first observations after migration. */
export const statementImportMembers = sql`"StatementImportRow"`;
