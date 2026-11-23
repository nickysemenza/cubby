/**
 * `runs.reconcile` (ADR 0029 section 7): projects stopped execution onto Run
 * status. A `run.execute` Pass that spent its attempts fails its Run with the
 * raw error; `purchase.dispatch` projects exhausted dispatch claims. A lapsed Pass claim needs no
 * reconciliation: the kernel's claim expiry hands the page to the next
 * worker. One instance; it re-checks every 15 minutes while executed Runs are
 * active and hourly otherwise, and a Pass that fails its last attempt brings
 * it forward.
 */
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { lockMailDiscoveryAdmission } from "~/server/domains/purchase-import/repo/gmail/discovery-admission";
import { reconcileCoordinatorDispatches } from "~/server/domains/run/repo/coordinator-dispatch";
import { RUN_EXECUTE_PASS } from "~/server/domains/run/repo/run-execution";
import { definePass, startPass } from "~/server/kernel/api";

import { releaseMailDiscoveryAdmission } from "./lifecycle";

const RUNS_RECONCILE_PASS = "runs.reconcile";

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
async function reconcileStuckRunPasses(db: Database): Promise<number> {
  return repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    // Exhausted unfinished Passes first, then their Runs by primary key. The
    // text comparison keeps the join to the Run whose canonical id is the key.
    const stuck = await q.execute<{
      id: string;
      lastError: string | null;
      ledgerPartyId: string | null;
      mailboxId: string | null;
    }>(sql`
    SELECT r.id, p."lastError", r."ledgerPartyId",
      CASE WHEN r.purpose = ${runPurpose.enum.mail_discovery} THEN r.input->>'mailboxId' END AS "mailboxId"
    FROM "Pass" p
    JOIN "Run" r ON r.id = CASE WHEN pg_input_is_valid(p.key, ${"uuid"}) THEN p.key::uuid END
      AND r.id::text = p.key
    WHERE p.name = ${RUN_EXECUTE_PASS}
      AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p.attempts >= p."maxAttempts"
      AND (p."claimToken" IS NULL OR p."claimDeadline" <= now())
      AND (r.status = ${runStatus.enum.running}
        OR (r.status = ${runStatus.enum.paused_auth} AND r."failureCode" = 'execution_limit'))
    LIMIT 100`);
    // Mailbox admission precedes the gate and Run rows (see
    // `releaseMailDiscoveryAdmission`). Several mailboxes lock in one order.
    const mailboxes = [
      ...new Map(
        stuck.rows.flatMap((row) =>
          row.ledgerPartyId && row.mailboxId
            ? [
                [
                  `${row.ledgerPartyId}:${row.mailboxId}`,
                  {
                    ledgerPartyId: row.ledgerPartyId,
                    mailboxId: row.mailboxId,
                  },
                ] as const,
              ]
            : [],
        ),
      ),
    ]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, mailbox]) => mailbox);
    for (const mailbox of mailboxes)
      await lockMailDiscoveryAdmission(tx, mailbox);
    const kernel = await import("~/server/kernel/api");
    const write = {
      table: (await import("~/server/db/retained-tables")).run,
      entity: "run",
      ids: stuck.rows.map((row) => row.id),
      columns: ["status", "endedAt", "failureCode"],
    };
    // Revisions before the Run rows, the order a kernel apply takes; each
    // update re-checks the status it reads.
    await kernel.lockWrites(tx, write);
    let failed = 0;
    for (const row of stuck.rows) {
      const updated = await q.execute<{ id: string }>(sql`
      UPDATE "Run" SET status = ${runStatus.enum.failed}, "failureCode" = 'job_failed',
        "dispatchError" = ${failureTextOf(row.lastError)}, "endedAt" = now(), "updatedAt" = now()
      WHERE id = ${row.id}::uuid AND (status = ${runStatus.enum.running}
        OR (status = ${runStatus.enum.paused_auth} AND "failureCode" = 'execution_limit'))
      RETURNING id`);
      if (updated.rows.length)
        await kernel.emitWrites(tx, { ...write, ids: [row.id] });
      failed += updated.rows.length;
    }
    for (const mailbox of mailboxes)
      await releaseMailDiscoveryAdmission(tx, mailbox);
    return failed;
  });
}

/** Every stopped execution's Run, projected; returns how many Runs changed. */
export async function reconcileRunPasses(db: Database): Promise<number> {
  return (
    (await reconcileCoordinatorDispatches(db)) +
    (await reconcileStuckRunPasses(db))
  );
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
    await reconcileRunPasses(db);
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
