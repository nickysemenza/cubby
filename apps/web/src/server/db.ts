import { AsyncLocalStorage } from "node:async_hooks";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  acquireTracedConnection,
  type RequestDbRole,
  tracePool,
  traceStandaloneClient,
} from "./db-pg-tracing";
import {
  DatabaseRuntimeResolver,
  type RequestDatabaseRuntimeScope,
  type RequestDbConnections,
} from "./db-runtime-resolver";
import {
  Database,
  type DatabaseClient,
  type DatabaseRuntime,
} from "./db/database";
import * as schema from "./db/schema";
import { TraceNames, withTrace } from "./tracing";

export { Database };
export type { RequestDbConnections };

const requestDbStore = new AsyncLocalStorage<RequestDatabaseRuntimeScope>();

const runtimeForClient = (client: DatabaseClient): DatabaseRuntime => ({
  client,
  withConnection: (fn) => fn(client),
});

const runtimeForPool = (
  pool: pg.Pool,
  role: RequestDbRole,
): DatabaseRuntime => {
  const tracedPool = tracePool(pool, role);
  const client = drizzleNodePostgres({ client: tracedPool, schema });
  return {
    client,
    withConnection: async (fn) => {
      const connection = await acquireTracedConnection(tracedPool, false);
      try {
        return await fn(drizzleNodePostgres({ client: connection, schema }));
      } finally {
        connection.release();
      }
    },
  };
};

const createPoolRuntime = (
  connectionString: string,
  max: number,
  role: RequestDbRole,
): DatabaseRuntime =>
  runtimeForPool(new pg.Pool({ connectionString, max }), role);

/**
 * Run a function with per-request strong and bounded-stale database bindings.
 * Pool construction remains lazy: requests that never resolve a Database
 * handle never create a local pg pool or wake the origin database.
 */
export const withRequestDb = async <T>(
  connections: RequestDbConnections,
  fn: () => Promise<T>,
): Promise<T> => {
  const holder: RequestDatabaseRuntimeScope = { connections, runtimes: {} };
  return requestDbStore.run(holder, fn);
};

/**
 * Background-invocation scope. One connected client is shared by one Queue
 * invocation or one Workflow step; Hyperdrive and the Worker runtime retain
 * responsibility for socket cleanup. Never carry this scope across Workflow
 * steps.
 */
export const withRequestDbClient = async <T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const client = traceStandaloneClient(
    new pg.Client({ connectionString }),
    "strong",
  );
  const startedAt = performance.now();
  await withTrace(TraceNames.db("connect"), async (span) => {
    await client.connect();
    span.setAttributes({
      "db.system.name": "postgresql",
      "db.namespace": "cubby",
      "db.connect.duration_ms": Math.round(performance.now() - startedAt),
    });
  });
  const runtime = runtimeForClient(drizzleNodePostgres({ client, schema }));
  const holder: RequestDatabaseRuntimeScope = {
    connections: {
      strong: connectionString,
      boundedStale: connectionString,
    },
    runtimes: { strong: runtime },
  };
  return requestDbStore.run(holder, fn);
};

declare const __CF_WORKERS__: boolean | undefined;
const isCloudflareWorkerBuild = (
  flag: boolean | undefined = typeof __CF_WORKERS__ === "undefined"
    ? undefined
    : __CF_WORKERS__,
): flag is true => flag === true;
const isCFWorkers = isCloudflareWorkerBuild();

const MODULE_DATABASE_RUNTIME = Symbol.for("cubby.database.runtime");
interface GlobalDatabaseRuntime {
  [MODULE_DATABASE_RUNTIME]?: DatabaseRuntime;
}
const globalForDatabase: typeof globalThis & GlobalDatabaseRuntime = globalThis;

let moduleRuntime: DatabaseRuntime | undefined;
if (!isCFWorkers) {
  const databaseUrl = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required outside Cloudflare Workers");
  }
  moduleRuntime =
    globalForDatabase[MODULE_DATABASE_RUNTIME] ??
    createPoolRuntime(databaseUrl, 25, "strong");
  if (process.env.NODE_ENV !== "production") {
    globalForDatabase[MODULE_DATABASE_RUNTIME] = moduleRuntime;
  }
}

const runtimeResolver = new DatabaseRuntimeResolver({
  requestScope: () => requestDbStore.getStore(),
  moduleRuntime: () => moduleRuntime,
  createRuntime: createPoolRuntime,
});

const strongDatabase = new Database(() => runtimeResolver.resolve("strong"));
export const db = strongDatabase;

/** Explicitly approved briefly stale reads use the request's stale binding. */
export const boundedStaleDb = isCFWorkers
  ? new Database(() => runtimeResolver.resolve("bounded-stale"))
  : strongDatabase;

/**
 * Better Auth needs Drizzle's query-builder methods at configuration time.
 * These concrete getters bind each operation to the current strong request
 * client when Better Auth actually invokes it; no dynamic property proxy is
 * involved, and the supplied auth schema means it never reads Drizzle `_`.
 */
export const drizzle = {
  get select() {
    const client = strongDatabase.clientForRepository();
    return client.select.bind(client);
  },
  get insert() {
    const client = strongDatabase.clientForRepository();
    return client.insert.bind(client);
  },
  get update() {
    const client = strongDatabase.clientForRepository();
    return client.update.bind(client);
  },
  get delete() {
    const client = strongDatabase.clientForRepository();
    return client.delete.bind(client);
  },
  get transaction() {
    const client = strongDatabase.clientForRepository();
    return client.transaction.bind(client);
  },
};

/**
 * Run `fn` with a Database bound to one checked-out connection. No transaction
 * is opened; independent reads merely share the same physical connection.
 */
export const withConnection = async <T>(
  database: Database,
  fn: (scoped: Database) => Promise<T>,
): Promise<T> =>
  database.withClientConnection(async (client) => {
    const runtime = runtimeForClient(client);
    return await fn(new Database(() => runtime));
  });

export type DrizzleClient = DatabaseClient;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
