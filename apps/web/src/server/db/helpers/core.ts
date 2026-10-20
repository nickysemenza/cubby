import { sleep } from "@cubby/shared/retry";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { Database } from "~/server/db/database";
import {
  createDatabase,
  resolveDatabaseRuntime,
} from "~/server/db/database-runtime";
import type { RepositoryQueryTransaction } from "~/server/db/repository-access.boundary";
import { isSerializationFailure } from "~/server/errors/db-errors";
import { TraceNames, withTrace } from "~/server/observability/tracing";

/** Work that must not happen unless the enclosing transaction commits. */
export type AfterCommitEffect = (committedDb: Database) => Promise<void>;

/**
 * After-commit effects of each open {@link withTransaction}, keyed by both its
 * `DrizzleTransaction` and every `Database` facade over it.
 *
 * Contract: an effect enrolled through {@link runAfterCommit} on a
 * transaction-bound handle runs only once the OUTERMOST `withTransaction`
 * commits, with that transaction's root `Database`. A nested boundary is a
 * savepoint, not a commit: on release its effects move to the parent; on
 * rollback they are dropped with its rows. Queue publications and R2 deletes
 * go through here, so a unit nested in a caller's transaction (the MCP
 * purchase-agent call, a kernel write inside a workflow) neither wakes a
 * consumer before its rows are visible nor destroys bytes for rows a later
 * rollback restores. A transaction opened with a raw `.transaction()` instead
 * of `withTransaction` has no commit boundary and rejects deferred effects.
 */
const afterCommitQueues = new WeakMap<object, AfterCommitEffect[]>();
type BeforeCommitEffect = (tx: DrizzleTransaction) => Promise<void>;
type BeforeCommitEntry = {
  effect: BeforeCommitEffect;
  phase: "validation" | "fence" | "capture";
  changedKeys: readonly string[];
};
const beforeCommitQueues = new WeakMap<object, BeforeCommitEntry[]>();

/** Includes released savepoints; a rolled-back child never reaches its parent. */
export const pendingTransactionChanges = (
  db: Database | RepositoryQueryTransaction,
): string[] => {
  const seen = new Set<object>();
  const keys: string[] = [];
  let current: Database | RepositoryQueryTransaction | undefined = db;
  while (current) {
    const queue = beforeCommitQueues.get(current);
    if (queue && !seen.has(queue)) {
      seen.add(queue);
      keys.push(...queue.flatMap((entry) => entry.changedKeys));
    }
    current = transactionParents.get(
      "rollback" in current ? current : getDb(current),
    );
  }
  return keys;
};

/** Metadata follows all business writes, including successfully released savepoints. */
export const runBeforeCommit = async (
  db: Database | RepositoryQueryTransaction,
  effect: BeforeCommitEffect,
  options: {
    phase?: "validation" | "fence" | "capture";
    changedKeys?: readonly string[];
  } = {},
): Promise<void> => {
  const pending = beforeCommitQueues.get(db);
  if (pending) {
    pending.push({
      effect,
      phase: options.phase ?? "capture",
      changedKeys: options.changedKeys ?? [],
    });
    return;
  }
  if ("rollback" in db)
    throw new Error(
      "Before-commit work requires a transaction opened with withTransaction",
    );
  await withTransaction(db, effect);
};

// Active savepoint ancestry lets scoped server capabilities follow kernel writes
// without granting authority to the request pool or later transactions.
const transactionParents = new WeakMap<object, Database>();

/** Final semantic checks run before the revision lock and metadata flush. */
export const runBeforeCommitDatabase = (
  db: Database,
  effect: (tx: Database) => Promise<void>,
  phase: "validation" | "fence",
) => runBeforeCommit(db, (tx) => effect(databaseForTransaction(tx)), { phase });

/**
 * Run `effect` now on a pool-bound handle; on a handle inside a
 * {@link withTransaction}, hold it until the outermost commit.
 */
export const runAfterCommit = async (
  db: Database | RepositoryQueryTransaction,
  effect: AfterCommitEffect,
): Promise<void> => {
  const pending = afterCommitQueues.get(db);
  if (pending) {
    pending.push(effect);
    return;
  }
  if (!("rollback" in db)) await effect(db);
  else {
    const parent = transactionParents.get(db);
    if (!parent)
      throw new Error(
        "After-commit work requires a transaction opened with withTransaction",
      );
    await effect(parent);
  }
};

/** Every effect is attempted; the transaction already committed either way. */
const flushAfterCommit = async (
  db: Database,
  effects: readonly AfterCommitEffect[],
): Promise<void> => {
  const failures: unknown[] = [];
  for (const effect of effects) {
    try {
      await effect(db);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1)
    throw new Error(
      "Transaction committed, but an after-commit effect failed",
      {
        cause: failures[0],
      },
    );
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Transaction committed, but ${failures.length} after-commit effects failed`,
    );
};

/**
 * Get the underlying Drizzle client from the request-scoped Database handle.
 * This should ONLY be used within repo files to access the database.
 * Services and routers should never call this - they just pass Database around.
 */
export const getDb = (db: Database): DrizzleClient => {
  return resolveDatabaseRuntime(db).client;
};

/**
 * Is this handle an already-open transaction rather than the pooled Database?
 *
 * The `"rollback"` discriminator is shared with the schema-free repository boundary: repository code receives
 * either the request-scoped Database handle or a DrizzleTransaction, and the
 * transaction carries `rollback`, so presence of that key is the structural
 * signal separating them.
 * Keep {@link unwrapDb}, {@link withTransactionOn}, and the schema-free
 * repository boundary aligned; constructor identity does not survive module reloads.
 */
export const isTransaction = (
  db: Database | DrizzleClient | DrizzleTransaction,
): db is DrizzleTransaction => "rollback" in db;

/**
 * Safely unwrap Database or use DrizzleTransaction directly.
 * Detects if the input is already a DrizzleTransaction and returns it,
 * otherwise resolves the Database handle's repository client.
 */
export const unwrapDb = (
  db: Database | DrizzleTransaction,
): DrizzleClient | DrizzleTransaction => {
  return isTransaction(db) ? db : getDb(db);
};

export const parentTransactionDatabase = (
  db: Database | RepositoryQueryTransaction,
): Database | undefined => {
  return transactionParents.get("rollback" in db ? db : getDb(db));
};

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
const withTransactionAttempts = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
  config: PgTransactionConfig | undefined,
  attempts: number,
): Promise<T> => {
  const parentBefore = beforeCommitQueues.get(db);
  const limit = isTransaction(getDb(db)) ? 1 : attempts;
  for (let attempt = 1; ; attempt++) {
    const pending: AfterCommitEffect[] = [];
    const before: BeforeCommitEntry[] = [];
    let result: T;
    try {
      result = await withTrace(TraceNames.db("transaction"), async () => {
        return await getDb(db).transaction(async (tx) => {
          afterCommitQueues.set(tx, pending);
          beforeCommitQueues.set(tx, before);
          transactionParents.set(tx, db);
          try {
            const value = await fn(tx);
            if (!parentBefore) {
              for (const entry of before.filter(
                (entry) => entry.phase === "validation",
              ))
                await entry.effect(tx);
              for (const entry of before.filter(
                (entry) => entry.phase === "fence",
              ))
                await entry.effect(tx);
              for (const entry of before.filter(
                (entry) => entry.phase === "capture",
              ))
                await entry.effect(tx);
            }
            return value;
          } finally {
            transactionParents.delete(tx);
          }
        }, config);
      });
    } catch (error) {
      if (attempt >= limit || !isSerializationFailure(error)) throw error;
      // Immediate retries can collide with the same background publication page.
      await sleep(200 * attempt);
      continue;
    }
    // Commit succeeded: effect failures must never enter the replay catch.
    if (parentBefore) parentBefore.push(...before);
    const parent = afterCommitQueues.get(db);
    if (parent) parent.push(...pending);
    else await flushAfterCommit(db, pending);
    return result;
  }
};

export const withTransaction = <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> => withTransactionAttempts(db, fn, config, 1);

type SnapshotWriteConfig = PgTransactionConfig & {
  isolationLevel: "serializable" | "repeatable read";
  accessMode?: "read write";
};

/**
 * Opt-in recovery for DB-only snapshot writes. Rebuild all callback-local
 * state and revalidate the original review on each attempt; effects and
 * publication buffers belong to that attempt's transaction. Caller-owned
 * boundaries execute once, and committed consumer failures never replay.
 */
export const withSnapshotWrite = <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
  config: SnapshotWriteConfig,
): Promise<T> => withTransactionAttempts(db, fn, config, 3);

/**
 * Composable transaction: **join** the caller's transaction when one is already
 * open, otherwise open one.
 *
 * Deliberately a different name from {@link withTransaction} rather than an
 * overload of it, because the two make different promises:
 *
 * - `withTransaction` promises *"I own a boundary"* — and its `db.transaction`
 *   trace span says exactly that.
 * - `withTransactionOn` promises only the weaker, composable *"my writes are
 *   atomic with whatever is already open"*. On the join path there is no new
 *   boundary, so emitting a `db.transaction` span there would attribute one to a
 *   caller that never opened it — while the enclosing `withTransaction`, which
 *   really does own it, already has the span.
 *
 * Use this for a repo write that must be atomic but may also be one step of a
 * larger caller-owned transaction (see `createEntityCrud`'s `update` in `repo/repository.ts`).
 */
export const withTransactionOn = async <T>(
  db: Database | DrizzleTransaction,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> => {
  return isTransaction(db) ? fn(db) : withTransaction(db, fn);
};

/**
 * A `Database` handle whose repository client IS the open transaction, so
 * repository functions that take a `Database` (and open their own
 * transactions) run inside the caller's boundary: nested transactions become
 * savepoints. This is how one write and its derived projections commit
 * together without every repository learning a second parameter type.
 */
export const databaseForTransaction = (tx: DrizzleTransaction): Database => {
  const client = tx;
  const database = createDatabase(() => ({
    client,
    withConnection: (fn) => fn(client),
  }));
  const pending = afterCommitQueues.get(tx);
  if (pending) afterCommitQueues.set(database, pending);
  const before = beforeCommitQueues.get(tx);
  if (before) beforeCommitQueues.set(database, before);
  return database;
};

/** {@link withTransaction} whose callback receives a transaction-backed `Database`. */
export const withTransactionDatabase = async <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> =>
  withTransaction(db, (tx) => fn(databaseForTransaction(tx)), config);

export const withSnapshotWriteDatabase = <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
  config: SnapshotWriteConfig,
): Promise<T> =>
  withSnapshotWrite(db, (tx) => fn(databaseForTransaction(tx)), config);
