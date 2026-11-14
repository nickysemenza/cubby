import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger } from "@cubby/worker-tracing";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";

import { mergeDatabaseChanges, type DatabaseChanges } from "~/lib/doorbell";
import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { Database } from "~/server/db/database";
import {
  createDatabase,
  resolveDatabaseRuntime,
} from "~/server/db/database-runtime";
import { notifyDatabaseChanges } from "~/server/db/freshness/client";
import type { RepositoryQueryTransaction } from "~/server/db/repository-access.boundary";
import { findPgError } from "~/server/errors/db-errors";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const transactionLog = createLogger("db-transaction");

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
type KeyedAfterCommit = {
  key: string;
  items: unknown[];
  flush: (db: Database, items: unknown[]) => Promise<void>;
};
type AfterCommitEntry = AfterCommitEffect | KeyedAfterCommit;
const afterCommitQueues = new WeakMap<object, AfterCommitEntry[]>();
const afterCommitScope = new AsyncLocalStorage<AfterCommitEntry[]>();

const enrollAfterCommit = (
  queue: AfterCommitEntry[],
  entry: AfterCommitEntry,
) => {
  if (typeof entry !== "function") {
    const existing = queue.find(
      (item) => typeof item !== "function" && item.key === entry.key,
    );
    if (existing && typeof existing !== "function") {
      existing.items.push(...entry.items);
      return;
    }
  }
  queue.push(entry);
};

/** Coalesce keyed effects across commits in one request scope. */
export async function withAfterCommitScope<T>(
  fn: () => Promise<T>,
  finish: (flush: () => Promise<void>) => Promise<void> = (flush) => flush(),
): Promise<T> {
  if (afterCommitScope.getStore()) return fn();
  const pending: AfterCommitEntry[] = [];
  return afterCommitScope.run(pending, async () => {
    try {
      return await fn();
    } finally {
      await finish(async () => {
        for (const entry of pending) {
          if (typeof entry === "function") continue;
          try {
            await entry.flush(scopeDatabases.get(entry)!, entry.items);
          } catch (error) {
            transactionLog.error("After-commit scoped effect failed", {
              error: String(error),
            });
          }
        }
      });
    }
  });
}
const scopeDatabases = new WeakMap<KeyedAfterCommit, Database>();
const committedChanges = new WeakMap<object, DatabaseChanges>();

/** Changes follow savepoint ownership; only a successful outer commit publishes. */
export async function recordCommittedChanges(
  db: Database | RepositoryQueryTransaction,
  changes: DatabaseChanges,
): Promise<void> {
  if (!Object.keys(changes).length) return;
  const pending = committedChanges.get(db);
  if (pending) {
    mergeDatabaseChanges(pending, changes);
    return;
  }
  if ("rollback" in db)
    throw new Error("Change notifications require withTransaction");
  await notifyDatabaseChanges(changes);
}
type BeforeCommitEffect = (tx: DrizzleTransaction) => Promise<void>;
type BeforeCommitEntry = {
  effect: BeforeCommitEffect;
  phase: "validation" | "fence" | "capture" | "publication";
  /** One enrollment per outer transaction, including released savepoints. */
  key?: string;
};
const beforeCommitQueues = new WeakMap<object, BeforeCommitEntry[]>();

const enrollBeforeCommit = (
  queue: BeforeCommitEntry[],
  entry: BeforeCommitEntry,
) => {
  if (
    entry.key !== undefined &&
    queue.some(
      (existing) =>
        existing.key === entry.key && existing.phase === entry.phase,
    )
  )
    return;
  queue.push(entry);
};

/** Metadata follows all business writes, including successfully released savepoints. */
export const runBeforeCommit = async (
  db: Database | RepositoryQueryTransaction,
  effect: BeforeCommitEffect,
  options: {
    phase?: "validation" | "fence" | "capture" | "publication";
    key?: string;
  } = {},
): Promise<void> => {
  const pending = beforeCommitQueues.get(db);
  if (pending) {
    enrollBeforeCommit(pending, {
      effect,
      phase: options.phase ?? "capture",
      key: options.key,
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

/** Enroll facade-based work in the outer commit phase. */
export const runBeforeCommitDatabase = (
  db: Database,
  effect: (tx: Database) => Promise<void>,
  phase: "validation" | "fence" | "capture" | "publication",
) => runBeforeCommit(db, (tx) => effect(databaseForTransaction(tx)), { phase });

/**
 * Run `effect` now on a pool-bound handle; on a handle inside a
 * {@link withTransaction}, hold it until the outermost commit.
 */
export function runAfterCommit<T>(
  db: Database | RepositoryQueryTransaction,
  effect: {
    key: string;
    items: T[];
    flush: (db: Database, items: T[]) => Promise<void>;
  },
): Promise<void>;
export function runAfterCommit(
  db: Database | RepositoryQueryTransaction,
  effect: AfterCommitEffect,
): Promise<void>;
export async function runAfterCommit<T>(
  db: Database | RepositoryQueryTransaction,
  effect:
    | AfterCommitEffect
    | {
        key: string;
        items: T[];
        flush: (db: Database, items: T[]) => Promise<void>;
      },
): Promise<void> {
  const entry: AfterCommitEntry =
    typeof effect === "function"
      ? effect
      : {
          key: effect.key,
          items: [...effect.items],
          flush: (committedDb, items) => {
            // SAFETY: Each key identifies one item type, preserved when its entries merge.
            return effect.flush(committedDb, items as T[]);
          },
        };
  const pending = afterCommitQueues.get(db);
  if (pending) {
    enrollAfterCommit(pending, entry);
    return;
  }
  if (!("rollback" in db)) {
    const scope = afterCommitScope.getStore();
    if (typeof entry === "function") await entry(db);
    else if (scope) {
      if (
        !scope.some(
          (item) => typeof item !== "function" && item.key === entry.key,
        )
      )
        scopeDatabases.set(entry, db);
      enrollAfterCommit(scope, entry);
    } else await entry.flush(db, entry.items);
  } else {
    const parent = transactionParents.get(db);
    if (!parent)
      throw new Error(
        "After-commit work requires a transaction opened with withTransaction",
      );
    if (typeof entry === "function") await entry(parent);
    else await entry.flush(parent, entry.items);
  }
}

/** Every effect is attempted; the transaction already committed either way. */
const flushAfterCommit = async (
  db: Database,
  effects: readonly AfterCommitEntry[],
): Promise<void> => {
  const failures: unknown[] = [];
  for (const effect of effects) {
    try {
      if (typeof effect === "function") await effect(db);
      else {
        const scope = afterCommitScope.getStore();
        if (scope) {
          const existing = scope.find(
            (item) => typeof item !== "function" && item.key === effect.key,
          );
          if (!existing) scopeDatabases.set(effect, db);
          enrollAfterCommit(scope, effect);
        } else await effect.flush(db, effect.items);
      }
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
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> => {
  const parentBefore = beforeCommitQueues.get(db);
  const pending: AfterCommitEntry[] = [];
  const changes: DatabaseChanges = {};
  const before: BeforeCommitEntry[] = [];
  const result = await withTrace(TraceNames.db("transaction"), async () => {
    return await getDb(db).transaction(async (tx) => {
      afterCommitQueues.set(tx, pending);
      committedChanges.set(tx, changes);
      beforeCommitQueues.set(tx, before);
      transactionParents.set(tx, db);
      try {
        const value = await fn(tx);
        if (!parentBefore) {
          // Capture may wait for another writer. Recheck live ownership
          // after that work, then complete Jobs in the same transaction.
          for (const commitPhase of [
            "validation",
            "fence",
            "capture",
            "publication",
          ] as const)
            for (const entry of before.filter(
              (entry) => entry.phase === commitPhase,
            ))
              await entry.effect(tx);
        }
        return value;
      } finally {
        transactionParents.delete(tx);
      }
    }, config);
  });
  // Commit succeeded: effect failures must never roll the business result back.
  if (parentBefore)
    for (const entry of before) enrollBeforeCommit(parentBefore, entry);
  const parent = afterCommitQueues.get(db);
  const parentChanges = committedChanges.get(db);
  if (parentChanges) {
    mergeDatabaseChanges(parentChanges, changes);
  } else if (Object.keys(changes).length) {
    await notifyDatabaseChanges(changes);
  }
  if (parent) for (const entry of pending) enrollAfterCommit(parent, entry);
  else await flushAfterCommit(db, pending);
  return result;
};

/**
 * `householdWrite` for a callback that takes the native transaction: read
 * committed, with the household write gate as its first statement, so every
 * read after it sees the writers the gate serialized before it.
 */
export const withHouseholdWrite = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> => {
  const { enterWriteTransaction, HouseholdWriteBusyError } =
    await import("~/server/kernel/gate");
  try {
    return await withTransaction(db, async (tx) => {
      await enterWriteTransaction(tx, { lane: "money", mode: "member" });
      return fn(tx);
    });
  } catch (error) {
    if (findPgError(error)?.code === "55P03")
      throw new HouseholdWriteBusyError(error);
    throw error;
  }
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
  const client = tx;
  const database = createDatabase(() => ({
    client,
    withConnection: (fn) => fn(client),
  }));
  const pending = afterCommitQueues.get(tx);
  if (pending) afterCommitQueues.set(database, pending);
  const changes = committedChanges.get(tx);
  if (changes) committedChanges.set(database, changes);
  const before = beforeCommitQueues.get(tx);
  if (before) beforeCommitQueues.set(database, before);
  return database;
};

/** {@link withHouseholdWrite} whose callback receives a transaction-backed `Database`. */
export const withHouseholdWriteDatabase = <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
): Promise<T> => withHouseholdWrite(db, (tx) => fn(databaseForTransaction(tx)));

/** {@link withTransaction} whose callback receives a transaction-backed `Database`. */
export const withTransactionDatabase = async <T>(
  db: Database,
  fn: (transactionDb: Database) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> =>
  withTransaction(db, (tx) => fn(databaseForTransaction(tx)), config);
