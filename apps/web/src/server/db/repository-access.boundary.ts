import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { getDb } from "~/server/db/helpers/core";

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

export function repositoryQueries(
  db: RepositoryQueryInput,
): RepositoryQueryClient {
  return "rollback" in db ? db : getDb(db);
}
