import type { KernelLane } from "@cubby/schemas/kernel/machinery";
/**
 * The household write gate (ADR 0029 section 6): every transaction that
 * writes a money-lane column, raises or locks a kernel revision, or dirties a
 * scope takes this one transaction-scoped advisory lock at read committed.
 * `SET LOCAL` timeouts let Postgres release the gate when a Worker dies
 * mid-transaction.
 */
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { findPgError } from "~/server/errors/db-errors";
import { WorkRetryableError } from "~/server/kernel/work-errors";

type Q = Pick<RepositoryQueryClient, "execute">;

export type WriteMode = "background" | "member";

const TIMEOUTS = {
  // A member waits at most 2 s behind a background apply.
  member: { lock: 2_000, statement: 15_000, idle: 20_000, transaction: 20_000 },
  background: {
    // A held member gate must produce 55P03 before the transaction deadline.
    lock: 500,
    statement: 20_000,
    idle: 30_000,
    transaction: 1_500,
  },
} satisfies Record<
  WriteMode,
  { lock: number; statement: number; idle: number; transaction: number }
>;

/** A member's write found the gate held past its lock timeout; retry shortly. */
export class HouseholdWriteBusyError extends WorkRetryableError {
  override name = "HouseholdWriteBusyError";
  constructor(cause?: unknown) {
    super("Cubby is applying other changes; try again in a moment.", {
      cause,
    });
  }
}

const LIMITS_MARK = "cubby.write_limits";

/**
 * Set this transaction's limits with `SET LOCAL` semantics, unless an earlier
 * write entry already set them: a nested writer keeps the outer transaction's
 * limits and never resets its budget.
 */
const writeLimits = (mode: WriteMode) => {
  const limits = TIMEOUTS[mode];
  return sql`CASE WHEN coalesce(current_setting(${LIMITS_MARK}, true), '') = '' THEN
    set_config('lock_timeout', ${String(limits.lock)}, true)
    || set_config('statement_timeout', ${String(limits.statement)}, true)
    || set_config('idle_in_transaction_session_timeout', ${String(limits.idle)}, true)
    || set_config('transaction_timeout', ${String(limits.transaction)}, true)
    || set_config(${LIMITS_MARK}, ${mode}, true) ELSE '' END`;
};

const GATE_LOCK = sql`pg_advisory_xact_lock(hashtextextended('cubby:household-write', 0))`;

/**
 * Take the household write gate as select-list items; re-entrant within a
 * transaction. Every statement that locks a `KeyRev` or `ScopeDirty` row for
 * a mutation carries it, so a transaction holds the gate before its first
 * kernel lock. It applies a member write's limits first when the transaction
 * has none, so the lock wait is bounded and a dead Worker releases the gate.
 */
export const takeHouseholdGate = sql`${writeLimits("member")} AS limits, ${GATE_LOCK} AS gate`;

/** Whether this transaction holds the household write gate. */
const holdsHouseholdGate = sql`EXISTS (
  SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
    AND classid = ((hashtextextended('cubby:household-write', 0) >> 32) & 4294967295)::oid
    AND objid = (hashtextextended('cubby:household-write', 0) & 4294967295)::oid
    AND objsubid = 1 AND granted
)`;

/**
 * One statement: refuse unless the gate is held or the transaction has taken
 * no lock yet, then apply the limits and take the gate. A writer that held a
 * row while waiting for the gate could deadlock a gated apply, so every path
 * that takes the gate ahead of its row locks enters here.
 */
async function enterGate(q: Q, mode: WriteMode): Promise<void> {
  const state = await q.execute<{ ordered: boolean }>(sql`
    WITH state AS MATERIALIZED (SELECT ${holdsHouseholdGate} OR (
      pg_current_xact_id_if_assigned() IS NULL AND NOT EXISTS (
        SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
      )) AS ordered)
    SELECT ordered, CASE WHEN ordered THEN ${writeLimits(mode)} || ${GATE_LOCK}::text END
    FROM state`);
  if (!state.rows[0]?.ordered)
    throw new Error(
      "The household write gate must be the transaction's first lock; open householdWrite at the mutation boundary",
    );
}

/**
 * Take the gate at the start of a writer that locks records ahead of its
 * kernel writes, before any of its row locks.
 */
export async function enterHouseholdGate(
  db: Database,
  mode: WriteMode = "member",
): Promise<void> {
  await enterGate(repositoryQueries(db), mode);
}

/** Session limits for this transaction only, then the gate when the lane is money. */
export async function enterWriteTransaction(
  q: Q,
  options: { lane: KernelLane | null; mode: WriteMode },
): Promise<void> {
  if (options.lane === "money") return enterGate(q, options.mode);
  await q.execute(sql`SELECT ${writeLimits(options.mode)}`);
}

/**
 * A member or service write to money-lane columns: read committed, the gate,
 * and a lock timeout reported as {@link HouseholdWriteBusyError}.
 */
export async function householdWrite<T>(
  db: Database,
  work: (tx: Database) => Promise<T>,
  options: { mode: WriteMode } = { mode: "member" },
): Promise<T> {
  try {
    return await repositoryTransactionDatabase(db, async (tx) => {
      await enterWriteTransaction(repositoryQueries(tx), {
        lane: "money",
        mode: options.mode,
      });
      return work(tx);
    });
  } catch (error) {
    if (options.mode === "member" && findPgError(error)?.code === "55P03")
      throw new HouseholdWriteBusyError(error);
    throw error;
  }
}
