/**
 * Reads behind the Run summary Job: which Run ends are owed a summary, and
 * whether a Run still reads as the end a Job was published for.
 */
import type { RunId } from "@cubby/schemas/identifiers";
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  RUN_SUMMARY_CUTOFF,
  runSummaryGeneration,
  runSummaryWrittenSql,
} from "~/server/db/computed/run-ai-summary";
import { getDb, notDeleted, unwrapDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";

import { runDefaultPopulationSql } from "./run";

/** End states a summary describes; paused Runs have not ended. */
const ENDED_STATUSES = [
  "completed",
  "failed",
  "dispatch_failed",
  "needs_review",
] as const;

/** The key `runAiSummaryJobKey` (`background-tasks.ts`) builds, in SQL. */
const summaryJobKeySql = sql`'run-summary:' || ${runTable.id}::text || ':' ||
  (extract(epoch from date_trunc('milliseconds', ${runTable.endedAt})) * 1000)::bigint::text`;

/**
 * Ended Runs in the default Runs list with no summary of their current end
 * and no Job for it; an exhausted Job keeps its end from being owed again.
 */
const owedRunsWhere = () =>
  and(
    notDeleted(runTable),
    isNotNull(runTable.endedAt),
    gte(runTable.endedAt, RUN_SUMMARY_CUTOFF),
    inArray(runTable.status, [...ENDED_STATUSES]),
    runDefaultPopulationSql(),
    sql`NOT ${runSummaryWrittenSql(runTable.id, runTable.endedAt)}`,
    sql`NOT EXISTS (SELECT 1 FROM "Job" j WHERE j.key = ${summaryJobKeySql})`,
  );

/** The drain `due` row: the oldest owed Run end, when any is owed. */
export const runSummaryDueSql = () =>
  sql`SELECT 'run-summary'::text AS unit, false AS demand, owed.since
    FROM (SELECT min(${runTable.endedAt})::timestamp AS since FROM ${runTable}
      WHERE ${owedRunsWhere()}) owed
    WHERE owed.since IS NOT NULL`;

/** The oldest owed Run ends, as `{subjectRunId, endedAt}` generations. */
export async function listOwedRunSummaries(
  db: Parameters<typeof unwrapDb>[0],
  limit: number,
) {
  const owed = await unwrapDb(db)
    .select({ id: runTable.id, endedAt: runTable.endedAt })
    .from(runTable)
    .where(owedRunsWhere())
    .orderBy(asc(runTable.endedAt))
    .limit(limit);
  return owed.flatMap((entry) =>
    entry.endedAt
      ? [
          {
            subjectRunId: entry.id,
            endedAt: runSummaryGeneration(entry.endedAt),
          },
        ]
      : [],
  );
}

/**
 * True when the Run still reads as its ended generation `endedAt`. `lock`
 * reads it under a share lock, so a restart in flight waits for the caller.
 */
export async function runEndedAtGeneration(
  db: Database,
  runId: RunId,
  endedAt: string,
  lock = false,
) {
  const query = getDb(db)
    .select({ status: runTable.status, endedAt: runTable.endedAt })
    .from(runTable)
    .where(and(eq(runTable.id, runId), notDeleted(runTable)))
    .limit(1);
  const [row] = lock ? await query.for("share") : await query;
  return Boolean(
    row?.endedAt &&
    ENDED_STATUSES.some((status) => status === row.status) &&
    runSummaryGeneration(row.endedAt) === endedAt,
  );
}
