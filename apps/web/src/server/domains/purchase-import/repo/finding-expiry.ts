import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { sql, type SQL } from "drizzle-orm";

/** A deadline is exclusive: the finding expires at that instant. */
export const findingHasExpired = (
  expiresAt: Date | string | null,
  at = new Date(),
): boolean =>
  expiresAt !== null && new Date(expiresAt).getTime() <= at.getTime();

/**
 * An open, unexpired `run_finding` row of an AssessmentState alias. Read
 * eligibility never changes the finding's retained resolution history.
 */
export const activeFindingSql = (
  alias: string,
  at: Date | SQL = sql`now()`,
): SQL => {
  const column = (name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const cutoff =
    at instanceof Date ? sql`${at.toISOString()}::timestamptz` : at;
  return sql`(${column("family")} = ${assessmentFamily.enum.run_finding} AND ${column("active")} AND ${column("status")} = ${suggestionStatus.enum.pending} AND (${column("data")}->>${"expiresAt"} IS NULL OR (${column("data")}->>${"expiresAt"})::timestamptz > ${cutoff}))`;
};
