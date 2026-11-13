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

/**
 * Take the household write gate; re-entrant within a transaction. Every
 * statement that locks a `KeyRev` or `ScopeDirty` row for a mutation carries
 * it, so a transaction holds the gate before its first kernel lock.
 */
export const takeHouseholdGate = sql`pg_advisory_xact_lock(hashtextextended('cubby:household-write', 0))`;

/**
 * Take the gate at the start of a writer that locks records ahead of its
 * kernel writes; a writer that held a record while waiting for the gate could
 * deadlock a gated apply.
 */
export async function enterHouseholdGate(db: Database): Promise<void> {
  await repositoryQueries(db).execute(sql`SELECT ${takeHouseholdGate}`);
}

/** Whether this transaction holds the household write gate. */
export const holdsHouseholdGate = sql`EXISTS (
  SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
    AND classid = ((hashtextextended('cubby:household-write', 0) >> 32) & 4294967295)::oid
    AND objid = (hashtextextended('cubby:household-write', 0) & 4294967295)::oid
    AND objsubid = 1 AND granted
)`;

/** Session limits for this transaction only, then the gate when the lane is money. */
export async function enterWriteTransaction(
  q: Q,
  options: { lane: KernelLane | null; mode: WriteMode },
): Promise<void> {
  const limits = TIMEOUTS[options.mode];
  const state = await q.execute<{
    ordered: boolean;
  }>(sql`WITH gate AS MATERIALIZED (
    SELECT ${holdsHouseholdGate} AS held
  ) SELECT
    (${options.lane !== "money"} OR (
      pg_current_xact_id_if_assigned() IS NULL AND NOT EXISTS (
        SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
      )
    ) OR gate.held) AS ordered,
    CASE WHEN gate.held THEN current_setting('lock_timeout') ELSE set_config('lock_timeout', ${String(limits.lock)}, true) END,
    CASE WHEN gate.held THEN current_setting('statement_timeout') ELSE set_config('statement_timeout', ${String(limits.statement)}, true) END,
    CASE WHEN gate.held THEN current_setting('idle_in_transaction_session_timeout') ELSE set_config('idle_in_transaction_session_timeout', ${String(limits.idle)}, true) END,
    CASE WHEN gate.held THEN current_setting('transaction_timeout') ELSE set_config('transaction_timeout', ${String(limits.transaction)}, true) END
    FROM gate`);
  if (!state.rows[0]?.ordered)
    throw new Error(
      "The household write gate must be the transaction's first lock; open householdWrite at the mutation boundary",
    );
  if (options.lane === "money")
    await q.execute(sql`SELECT ${takeHouseholdGate}`);
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
