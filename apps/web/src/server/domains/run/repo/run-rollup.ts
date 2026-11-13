import {
  summarizeRunWait,
  type WorkWaitingOnReason,
  type RunWaitingOn,
} from "@cubby/schemas/execution";
import type { RunId } from "@cubby/schemas/identifiers";
import { askState } from "@cubby/schemas/kernel/machinery";
import { runStatus } from "@cubby/schemas/run-fields";
import { inArray, sql, type SQL } from "drizzle-orm";

import { formatInstant } from "~/lib/date-format";
import type { Database } from "~/server/db/database";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { outer, related } from "~/server/db/helpers/related";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { run } from "~/server/db/retained-tables";

import {
  readRunPasses,
  readDuePassPositions,
  runPassRollup,
  runPassStalled,
  runPassWorking,
  fundingWaitUntilSql,
} from "./run-execution";
import {
  memberStoppedRunPredicate,
  retiredRunPredicate,
  queuedMailDiscoveryPredicate,
  historicalRoutineRunPredicate,
  settledAiRunPredicate,
} from "./work-attention";
const STALL_MS = 15 * 60_000;
export function runStalledSql(now = new Date()): SQL<boolean> {
  const id = outer(run.id);
  return sql<boolean>`(NOT ${runPassWorking(id)} AND (
    ${runPassStalled(id, sql`${now.toISOString()}::timestamp`, STALL_MS)} OR EXISTS (
      SELECT 1 FROM "Ask" a JOIN "AskScope" s ON s."askId" = a.id
      WHERE s."runId" = ${id} AND s."cancelledAt" IS NULL AND a."cancelledAt" IS NULL
        AND (a.state = ${askState.enum.unknown} OR a.state = ${askState.enum.queued} AND a.attempts >= a."maxAttempts")
    )))`;
}
export type RunRollup = {
  runId: string;
  waitingOn: RunWaitingOn | null;
  stalled: boolean;
};
/** Run waiting state comes from its kernel claims and requesting Ask links. */
export async function readRunRollups(
  db: Database,
  ids: readonly RunId[],
  now = new Date(),
): Promise<RunRollup[]> {
  if (!ids.length) return [];
  const q = repositoryQueries(db);
  const [owners, passes, positions, asks] = await Promise.all([
    q
      .select({
        id: run.id,
        code: run.shortcode,
        status: run.status,
        failureCode: run.failureCode,
        funding: sql<
          string | null
        >`to_char((${fundingWaitUntilSql(sql`${run.id}`)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        stalled: runStalledSql(now),
      })
      .from(run)
      .where(inArray(run.id, [...ids])),
    readRunPasses(db, ids),
    readDuePassPositions(db, ids),
    q.execute<{ runId: string; state: string; waitCause: string | null }>(sql`
      SELECT DISTINCT s."runId", a.id, a.state, a."waitCause" FROM "AskScope" s JOIN "Ask" a ON a.id = s."askId"
      WHERE s."runId" = ANY(${textArrayParam(ids)}::uuid[]) AND s."cancelledAt" IS NULL
        AND a."cancelledAt" IS NULL AND a.state <> ${askState.enum.answered}`),
  ]);
  return owners.map((owner) => {
    const pass = runPassRollup(passes.get(owner.id), positions.get(owner.id));
    const counts: Partial<Record<WorkWaitingOnReason, number>> = {};
    if (pass) counts[pass.reason] = 1;
    for (const ask of asks.rows.filter((item) => item.runId === owner.id)) {
      const reason =
        ask.state === "sent"
          ? "leased"
          : ask.waitCause === "funding"
            ? "waiting_funding"
            : "due";
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    if (owner.status === "paused") counts.paused = 1;
    return {
      runId: owner.code,
      stalled: owner.stalled,
      waitingOn: summarizeRunWait({
        now,
        formatTime: (at) => formatInstant(at, "clock"),
        waitingForFunding:
          owner.status === "paused_auth" &&
          owner.failureCode === "execution_limit",
        fundingResumeAt: owner.funding ? new Date(owner.funding) : null,
        groups: pass?.group ? [pass.group] : [],
        perMinute: new Map(
          pass?.group && pass.perMinute
            ? [[pass.group.kind, pass.perMinute]]
            : [],
        ),
        paceMinutes: 7 * 24 * 60,
        counts,
        expiredLeases: 0,
      }),
    };
  });
}

/** Member stops and retirement stay in history; successors take over stopped work. */
export function runNeedsAttentionSql(): SQL<boolean> {
  // `IS NOT NULL` lets the planner read the few successor rows through
  // `Run_predecessorRunId_idx`; without it a list-wide OR hashes every live Run.
  const successor = related(
    run,
    (next) =>
      sql`${next.predecessorRunId} = ${outer(run.id)} AND ${next.predecessorRunId} IS NOT NULL`,
  ).exists();
  return sql<boolean>`(NOT ${memberStoppedRunPredicate(sql`${run.failureCode}`)} AND NOT ${retiredRunPredicate(sql`${run.retiredAt}`)}
    AND NOT ${queuedMailDiscoveryPredicate({ id: outer(run.id), purpose: sql`${run.purpose}`, status: sql`${run.status}`, failureCode: sql`${run.failureCode}`, progress: sql`${run.progress}` })}
    AND (${runStalledSql()} OR (${run.status} IN (${runStatus.enum.paused},${runStatus.enum.paused_auth},${runStatus.enum.needs_review},${runStatus.enum.failed},${runStatus.enum.dispatch_failed}) AND NOT ${successor} AND NOT ${historicalRoutineRunPredicate({ id: outer(run.id), purpose: sql`${run.purpose}`, status: sql`${run.status}`, trigger: sql`${run.trigger}`, endedAt: sql`${run.endedAt}`, failureCode: sql`${run.failureCode}` })} AND NOT ${settledAiRunPredicate({ id: outer(run.id), purpose: sql`${run.purpose}`, status: sql`${run.status}`, failureCode: sql`${run.failureCode}` })})))`;
}
