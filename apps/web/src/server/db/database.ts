import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";

import type * as schema from "./schema";

/** The concrete Drizzle client repository adapters are allowed to use. */
export type DatabaseClient = PgDatabase<
  NodePgQueryResultHKT | PgliteQueryResultHKT,
  typeof schema
>;

export interface DatabaseRuntime {
  readonly client: DatabaseClient;
  withConnection<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T>;
}

/**
 * A real runtime handle with no query methods of its own. Services can pass it
 * around, while repository adapters explicitly resolve the current request's
 * Drizzle client. The resolver is private so role selection cannot leak into a
 * consumer or be captured before the Worker request scope exists.
 */
export class Database {
  readonly #resolveRuntime: () => DatabaseRuntime;

  constructor(resolveRuntime: () => DatabaseRuntime) {
    this.#resolveRuntime = resolveRuntime;
  }

  /** Repository boundary; application services must keep the handle opaque. */
  clientForRepository(): DatabaseClient {
    return this.#resolveRuntime().client;
  }

  /** Acquire one physical connection through the selected request role. */
  withClientConnection<T>(
    fn: (client: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    return this.#resolveRuntime().withConnection(fn);
  }
}
