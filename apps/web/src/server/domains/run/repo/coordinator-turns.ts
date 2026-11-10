/**
 * The household-wide cap on coordinator work turns
 * (docs/infrastructure.md#background-connection-budget). Every coordinator
 * request opens its own background pool, and admission never bounded how many
 * coordinators run at once, so ~180 running Mail imports could exhaust the
 * background origin cap. A coordinator holds a turn while it does database
 * work and releases it once it is idle; a crashed holder's turn lapses with
 * its lease. Holding is per Run: a coordinator renews its own row.
 */
import type { RunId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import { and, type AnyColumn, count, eq, lte, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { advisoryXactLock } from "~/server/db/advisory-lock";
import { runAfterCommit, withTransaction } from "~/server/db/helpers/core";
import { coordinatorTurn } from "~/server/db/schema";
import { bringOldestWaitingJobForward } from "~/server/generic/jobs/repo/operator";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/**
 * Concurrent coordinator turns. Each turn opens a two-socket background pool
 * per request; 6 × 2 leaves headroom in the 20 sockets permits, the cron and
 * telemetry do not hold (docs/infrastructure.md#background-connection-budget).
 */
export const COORDINATOR_TURN_CAP = 6;

/** Longer than one Durable Object alarm can run (15 minutes). */
const COORDINATOR_TURN_LEASE = sql`now() + interval '16 minutes'`;

export type CoordinatorTurnHold =
  | { held: true }
  | { held: false; holders: number };

/**
 * Take or renew this Run's turn. One short transaction under one advisory
 * lock: lapsed rows are reclaimed, a holder renews, and a new holder is
 * admitted only below the cap. A refused coordinator's row records that it is
 * alive and waiting, which keeps its Run out of stale-Run expiry.
 */
export async function holdCoordinatorTurn(
  db: Database,
  input: { runId: RunId; token: string; cap?: number },
): Promise<CoordinatorTurnHold> {
  const cap = input.cap ?? COORDINATOR_TURN_CAP;
  return withTransaction(db, async (tx) => {
    await advisoryXactLock(tx, "coordinator-turn", "household");
    await tx
      .delete(coordinatorTurn)
      .where(lte(coordinatorTurn.leaseExpiresAt, sql`now()`));
    const [own] = await tx
      .select({ held: coordinatorTurn.held })
      .from(coordinatorTurn)
      .where(eq(coordinatorTurn.runId, input.runId));
    const [counted] = own?.held
      ? [{ holders: 0 }]
      : await tx
          .select({ holders: count() })
          .from(coordinatorTurn)
          .where(eq(coordinatorTurn.held, true));
    const holders = counted?.holders ?? 0;
    const held = own?.held === true || holders < cap;
    const row = {
      held,
      leaseToken: input.token,
      leaseExpiresAt: COORDINATOR_TURN_LEASE,
    };
    await tx
      .insert(coordinatorTurn)
      .values({ runId: input.runId, ...row })
      .onConflictDoUpdate({ target: coordinatorTurn.runId, set: row });
    return held ? { held: true } : { held: false, holders };
  });
}

/** Runs whose coordinator holds or is waiting for a turn are alive, not stale. */
export const coordinatorTurnLive = (runId: AnyColumn) =>
  sql`EXISTS (SELECT 1 FROM ${coordinatorTurn} WHERE ${coordinatorTurn.runId} = ${runId} AND ${coordinatorTurn.leaseExpiresAt} > now())`;

/**
 * Release this Run's turn if `token` still holds it, and bring forward the
 * oldest dispatch that deferred for want of one. One per freed turn, so a
 * long wait does not wake every queued dispatch at once.
 */
export async function releaseCoordinatorTurn(
  db: Database,
  input: { runId: RunId; token: string },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const released = await tx
      .delete(coordinatorTurn)
      .where(
        and(
          eq(coordinatorTurn.runId, input.runId),
          eq(coordinatorTurn.leaseToken, input.token),
          eq(coordinatorTurn.held, true),
        ),
      )
      .returning({ runId: coordinatorTurn.runId });
    if (!released.length) return false;
    const woken = await bringOldestWaitingJobForward(
      tx,
      "purchase.dispatch",
      jobWaitReason.enum.provider_capacity,
    );
    if (woken)
      await runAfterCommit(tx, () =>
        wakeJobs({ source: "coordinator-turn.release" }),
      );
    return true;
  });
}
