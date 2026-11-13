/**
 * `runs.reconcile` (ADR 0029 section 7): projects stopped execution onto Run
 * status. A `run.execute` Pass that spent its attempts fails its Run with the
 * raw error; the mail discovery Job and `purchase.dispatch` Jobs that still
 * run as Jobs project their failures as before. A lapsed Pass claim needs no
 * reconciliation: the kernel's claim expiry hands the page to the next
 * worker. One instance; it re-checks every 15 minutes while executed Runs are
 * active and hourly otherwise, and a Pass that fails its last attempt brings
 * it forward.
 */
import { runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { reconcileCoordinatorDispatches } from "~/server/domains/run/repo/coordinator-dispatch";
import { RUN_EXECUTE_PASS } from "~/server/domains/run/repo/run-execution";
import { definePass, startPass } from "~/server/kernel/api";

import { reconcileWorkflowRuns } from "./lifecycle";

export const RUNS_RECONCILE_PASS = "runs.reconcile";

const ACTIVE_RECHECK_MS = 15 * 60_000;
const IDLE_RECHECK_MS = 60 * 60_000;

const storedCauses = z.object({
  causes: z.array(
    z.object({
      message: z.string().optional(),
      code: z.string().optional(),
    }),
  ),
});

/** A stored raw error (`describeErrorCauses` JSON) as the Run's failure text. */
function failureTextOf(raw: string | null): string {
  if (!raw) return "Run execution failed";
  try {
    const parsed = storedCauses.safeParse(JSON.parse(raw));
    const lines = (parsed.data?.causes ?? [])
      .map((cause) =>
        cause.code && cause.message
          ? `${cause.message} · ${cause.code}`
          : cause.message,
      )
      .filter((line): line is string => Boolean(line));
    return lines.length ? [...new Set(lines)].join("\n") : raw.slice(0, 600);
  } catch {
    return raw.slice(0, 600);
  }
}

/** Fail Runs whose `run.execute` Pass spent its attempts; returns how many. */
export async function reconcileStuckRunPasses(db: Database): Promise<number> {
  const q = repositoryQueries(db);
  const stuck = await q.execute<{ id: string; lastError: string | null }>(sql`
    SELECT r.id, p."lastError" FROM "Run" r
    JOIN "Pass" p ON p.name = ${RUN_EXECUTE_PASS} AND p.key = r.id::text
    WHERE p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p.attempts >= p."maxAttempts"
      AND (p."claimToken" IS NULL OR p."claimDeadline" <= now())
      AND (r.status = ${runStatus.enum.running}
        OR (r.status = ${runStatus.enum.paused_auth} AND r."failureCode" = 'execution_limit'))
    LIMIT 100`);
  let failed = 0;
  for (const row of stuck.rows) {
    const updated = await q.execute<{ id: string }>(sql`
      UPDATE "Run" SET status = ${runStatus.enum.failed}, "failureCode" = 'job_failed',
        "dispatchError" = ${failureTextOf(row.lastError)}, "endedAt" = now(), "updatedAt" = now()
      WHERE id = ${row.id}::uuid AND (status = ${runStatus.enum.running}
        OR (status = ${runStatus.enum.paused_auth} AND "failureCode" = 'execution_limit'))
      RETURNING id`);
    failed += updated.rows.length;
  }
  return failed;
}

/** Every stopped execution's Run, projected; returns how many Runs changed. */
export async function reconcileStoppedWork(db: Database) {
  let reconciled =
    (await reconcileCoordinatorDispatches(db)) +
    (await reconcileStuckRunPasses(db));
  let after: string | null = null;
  do {
    const page = await reconcileWorkflowRuns(db, after);
    reconciled += page.reconciled;
    after = page.next;
  } while (after);
  return reconciled;
}

async function executedRunsActive(db: Database) {
  const result = await repositoryQueries(db).execute<{ active: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS}
      AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL) AS active`);
  return result.rows[0]?.active ?? false;
}

export const runsReconcilePass = definePass({
  name: RUNS_RECONCILE_PASS,
  async run(db, cursor) {
    await reconcileStoppedWork(db);
    const wait = (await executedRunsActive(db))
      ? ACTIVE_RECHECK_MS
      : IDLE_RECHECK_MS;
    return {
      cursor,
      done: false,
      availableAt: new Date(Date.now() + wait),
    };
  },
});

/** Bring the reconciler forward, for a Pass about to spend its last attempt. */
export const scheduleRunsReconcile = (db: Database, at = new Date()) =>
  startPass(db, runsReconcilePass, { availableAt: at });
