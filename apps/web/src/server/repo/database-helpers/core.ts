import {
  Database,
  type DrizzleClient,
  type DrizzleTransaction,
} from "~/server/db";
import type { DatabaseClient } from "~/server/db/database";
import { TraceNames, withTrace } from "~/server/tracing";

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

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> => {
  return withTrace(TraceNames.db("transaction"), async () => {
    return await getDb(db).transaction(fn);
  });
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
 * larger caller-owned transaction (see `entity-crud-factory`'s `update`).
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
  return new Database(() => ({
    client,
    withConnection: (fn) => fn(client),
  }));
};

/** {@link withTransaction} whose callback receives a transaction-backed `Database`. */
export const withTransactionDatabase = async <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
): Promise<T> => withTransaction(db, (tx) => fn(databaseForTransaction(tx)));
