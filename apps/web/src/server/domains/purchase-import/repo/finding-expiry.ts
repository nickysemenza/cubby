import { suggestionStatus } from "@cubby/schemas/ai";
import { sql, type SQL } from "drizzle-orm";

/** A deadline is exclusive: the finding expires at that instant. */
export const findingHasExpired = (
  expiresAt: Date | string | null,
  at = new Date(),
): boolean =>
  expiresAt !== null && new Date(expiresAt).getTime() <= at.getTime();

/**
 * An open, unexpired row of a RunFinding alias. Read eligibility never changes
 * the finding's retained resolution history.
 */
export const activeFindingSql = (
  alias: string,
  at: Date | SQL = sql`now()`,
): SQL => {
  const column = (name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  // Stored timestamps are UTC wall clock without a zone.
  const cutoff =
    at instanceof Date
      ? sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
      : sql`(${at} AT TIME ZONE 'UTC')`;
  return sql`(${column("active")} AND ${column("status")} = ${suggestionStatus.enum.pending} AND (${column("expiresAt")} IS NULL OR ${column("expiresAt")} > ${cutoff}))`;
};
