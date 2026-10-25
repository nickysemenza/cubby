import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type {
  PgDatabase,
  PgTransaction,
  PgTransactionConfig,
} from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import {
  getDb,
  parentTransactionDatabase,
  withTransaction,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
  runAfterCommit,
  runBeforeCommit,
} from "~/server/db/helpers/core";

/** Native SQL builders without the assembled relational schema or pool ownership. */
export type RepositoryQueryClient = Pick<
  PgDatabase<NodePgQueryResultHKT>,
  | "select"
  | "selectDistinct"
  | "selectDistinctOn"
  | "insert"
  | "update"
  | "delete"
  | "execute"
  | "$with"
  | "with"
  | "$count"
>;
export type RepositoryQueryTransaction = RepositoryQueryClient &
  Pick<
    PgTransaction<
      NodePgQueryResultHKT,
      Record<string, never>,
      Record<string, never>
    >,
    "rollback"
  >;
export type RepositoryQueryInput = Database | RepositoryQueryTransaction;

export const repositoryBeforeCommit = (
  db: RepositoryQueryInput,
  effect: (tx: RepositoryQueryTransaction) => Promise<void>,
  options?: {
    phase?: "validation" | "fence" | "capture" | "publication";
    key?: string;
  },
): Promise<void> => runBeforeCommit(db, effect, options);

export const repositoryAfterCommit = (
  db: RepositoryQueryInput,
  effect: (committedDb: Database) => Promise<void>,
): Promise<void> => runAfterCommit(db, effect);

export function repositoryParentDatabase(
  db: RepositoryQueryInput,
): Database | undefined {
  return parentTransactionDatabase(db);
}

export function repositoryQueries(
  db: RepositoryQueryInput,
): RepositoryQueryClient {
  return "rollback" in db ? db : getDb(db);
}

/** A collision retry needs a native savepoint even inside a caller-owned transaction. */
export function repositorySavepoint<T>(
  db: RepositoryQueryInput,
  run: (tx: RepositoryQueryTransaction) => Promise<T>,
): Promise<T> {
  // SAFETY: repositoryQueries projects the native pool/transaction without
  // replacing it. Its native transaction method is deliberately erased from
  // RepositoryQueryClient so schema-specific transaction types cannot escape.
  const client = repositoryQueries(db) as RepositoryQueryClient & {
    transaction<R>(
      run: (tx: RepositoryQueryTransaction) => Promise<R>,
    ): Promise<R>;
  };
  return client.transaction(run);
}

/** Reuse the request/transaction runtime; projection never owns another client. */
export function repositoryTransaction<T>(
  db: Database,
  run: (tx: RepositoryQueryTransaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return withTransaction(db, run, config);
}

/** A passed native transaction is joined; a handle uses the existing savepoint policy. */
export function repositoryTransactionOn<T>(
  db: RepositoryQueryInput,
  run: (tx: RepositoryQueryTransaction) => Promise<T>,
): Promise<T> {
  return "rollback" in db ? run(db) : repositoryTransaction(db, run);
}

export function repositoryTransactionDatabase<T>(
  db: Database,
  run: (transactionDb: Database) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return withTransactionDatabase(db, run, config);
}

/** DB-only Job publications that must revalidate one serializable snapshot. */
export function repositorySnapshotWriteDatabase<T>(
  db: Database,
  run: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withSnapshotWriteDatabase(db, run, { isolationLevel: "serializable" });
}
