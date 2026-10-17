import { sql, type SQL } from "drizzle-orm";

// RunFinding's retained status column has no generated vocabulary schema.
const openFindingStatus = "open";

/** A deadline is exclusive: the finding expires at that instant. */
export const findingHasExpired = (
  expiresAt: Date | string | null,
  at = new Date(),
): boolean =>
  expiresAt !== null && new Date(expiresAt).getTime() <= at.getTime();

/** Read eligibility never changes the finding's retained resolution history. */
export const activeFindingSql = (
  alias: string,
  at: Date | SQL = sql`(now() AT TIME ZONE 'UTC')`,
): SQL => {
  const column = (name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  // Retained timestamps use UTC without a zone. A raw pg Date parameter
  // otherwise sends local time with an offset that this column ignores.
  const cutoff = at instanceof Date ? sql`${at.toISOString()}::timestamp` : at;
  return sql`(${column("status")} = ${openFindingStatus} AND (${column("expiresAt")} IS NULL OR ${column("expiresAt")} > ${cutoff}))`;
};
