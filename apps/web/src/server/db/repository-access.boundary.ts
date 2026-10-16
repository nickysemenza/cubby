import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type {
  PgDatabase,
  PgTransaction,
  PgTransactionConfig,
} from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { getDb, parentTransactionDatabase, withTransaction, withTransactionDatabase } from "~/server/db/helpers/core";

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
