import type { KernelLane } from "@cubby/schemas/kernel/machinery";
/**
 * The household write gate (ADR 0029 section 6): every transaction that
 * writes a money-lane column takes this one transaction-scoped advisory lock
 * at read committed. `SET LOCAL` timeouts let Postgres release the gate when
 * a Worker dies mid-transaction.
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

/** Session limits for this transaction only, then the gate when the lane is money. */
export async function enterWriteTransaction(
  q: Q,
  options: { lane: KernelLane | null; mode: WriteMode },
): Promise<void> {
  const limits = TIMEOUTS[options.mode];
  const state = await q.execute<{ ordered: boolean }>(sql`SELECT
    (${options.lane !== "money"} OR (
      pg_current_xact_id_if_assigned() IS NULL AND NOT EXISTS (
        SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
      )
    ) OR EXISTS (
      SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
        AND classid = ((hashtextextended('cubby:household-write', 0) >> 32) & 4294967295)::oid
        AND objid = (hashtextextended('cubby:household-write', 0) & 4294967295)::oid
        AND objsubid = 1 AND granted
    )) AS ordered,
    set_config('lock_timeout', ${String(limits.lock)}, true),
    set_config('statement_timeout', ${String(limits.statement)}, true),
    set_config('idle_in_transaction_session_timeout', ${String(limits.idle)}, true),
    set_config('transaction_timeout', ${String(limits.transaction)}, true)`);
  if (!state.rows[0]?.ordered)
    throw new Error(
      "The household write gate must be the transaction's first lock; open householdWrite at the mutation boundary",
    );
  if (options.lane === "money")
    await q.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('cubby:household-write', 0))`,
    );
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
