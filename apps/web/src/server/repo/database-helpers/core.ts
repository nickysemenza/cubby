import type { PgTransactionConfig } from "drizzle-orm/pg-core";

import {
  Database,
  type DrizzleClient,
  type DrizzleTransaction,
} from "~/server/db";
import type { DatabaseClient } from "~/server/db/database";
import { TraceNames, withTrace } from "~/server/tracing";

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
 * of `withTransaction` has no queue, so its effects run immediately.
 */
const afterCommitQueues = new WeakMap<object, AfterCommitEffect[]>();

// Active savepoint ancestry lets scoped server capabilities follow kernel writes
// without granting authority to the request pool or later transactions.
const transactionParents = new WeakMap<object, Database>();

/**
 * Run `effect` now on a pool-bound handle; on a handle inside a
 * {@link withTransaction}, hold it until the outermost commit.
 */
export const runAfterCommit = async (
  db: Database,
  effect: AfterCommitEffect,
): Promise<void> => {
  const pending = afterCommitQueues.get(db);
  if (pending) {
    pending.push(effect);
    return;
  }
  await effect(db);
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
  return db.clientForRepository();
};

/**
 * Is this handle an already-open transaction rather than the pooled Database?
 *
 * The `"rollback"` sniff lives here and nowhere else: repository code receives
 * either the request-scoped Database handle or a DrizzleTransaction, and the
 * transaction carries `rollback`, so presence of that key is the structural
 * signal separating them.
 * Centralized so the two consumers ({@link unwrapDb},
 * {@link withTransactionOn}) can't drift on it.
 */
export const isTransaction = (
  db: Database | DrizzleTransaction,
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
  db: Database | DrizzleTransaction,
): Database | undefined => {
  return transactionParents.get(unwrapDb(db));
};

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> => {
  const pending: AfterCommitEffect[] = [];
  const result = await withTrace(TraceNames.db("transaction"), async () => {
    return await getDb(db).transaction(async (tx) => {
      afterCommitQueues.set(tx, pending);
      transactionParents.set(tx, db);
      try {
        return await fn(tx);
      } finally {
        transactionParents.delete(tx);
      }
    }, config);
  });
  const parent = afterCommitQueues.get(db);
  if (parent) parent.push(...pending);
  else await flushAfterCommit(db, pending);
  return result;
};

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
  // SAFETY: the repository-only Database facade exposes the same schema-bound
  // Drizzle methods as DatabaseClient; nested transactions become savepoints.
  const client = tx as DatabaseClient;
  const database = new Database(() => ({
    client,
    withConnection: (fn) => fn(client),
  }));
  const pending = afterCommitQueues.get(tx);
  if (pending) afterCommitQueues.set(database, pending);
  return database;
};

/** {@link withTransaction} whose callback receives a transaction-backed `Database`. */
export const withTransactionDatabase = async <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> =>
  withTransaction(db, (tx) => fn(databaseForTransaction(tx)), config);
