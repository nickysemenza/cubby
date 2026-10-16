import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { Database } from "./database";
import type * as schema from "./schema";

/** The concrete Drizzle client repository adapters are allowed to use. */
export type DatabaseClient = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DatabaseRuntime {
  readonly client: DatabaseClient;
  withConnection<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T>;
}

// Keep resolver callbacks lazy: the same handle follows the active request role.
// Test module reloads and HMR must resolve handles created by the previous graph.
const runtimeRegistryKey = Symbol.for("cubby.database.runtime-registry");
const runtimeGlobal: typeof globalThis & {
  [runtimeRegistryKey]?: WeakMap<Database, () => DatabaseRuntime>;
} = globalThis;
const runtimes = (runtimeGlobal[runtimeRegistryKey] ??= new WeakMap<
  Database,
  () => DatabaseRuntime
>());

export function createDatabase(
  resolveRuntime: () => DatabaseRuntime,
): Database {
  const database = new Database();
  runtimes.set(database, resolveRuntime);
  return database;
}

export function resolveDatabaseRuntime(database: Database): DatabaseRuntime {
  const resolve = runtimes.get(database);
  if (!resolve) throw new Error("Database handle has no registered runtime");
  return resolve();
}
