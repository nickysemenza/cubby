import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger } from "@cubby/worker-tracing";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";

import { observeResponseBody } from "~/lib/response-body-observer";

import {
  afterExecutionTasks,
  getBackgroundDatabaseConnectionString,
} from "./cf-env";
import { Database } from "./db/database";
import {
  createDatabase,
  resolveDatabaseRuntime,
  type DatabaseClient,
  type DatabaseRuntime,
} from "./db/database-runtime";
import { createDatabaseClientConstructor } from "./db/db-pg-client";
import {
  acquireTracedConnection,
  pipelinedAutocommit,
  type RequestDbRole,
  tracePool,
} from "./db/db-pg-tracing";
import {
  DatabaseRuntimeResolver,
  type RequestDatabaseRuntimeScope,
  type RequestDbConnections,
} from "./db/db-runtime-resolver";
import { relationalSchema } from "./db/schema";

export { Database };
export type { RequestDbConnections };

const requestDbStore = new AsyncLocalStorage<RequestDatabaseRuntimeScope>();
const log = createLogger("db");

const runtimeForClient = (client: DatabaseClient): DatabaseRuntime => ({
  client,
  withConnection: (fn) => fn(client),
});

const runtimeForPool = (
  pool: pg.Pool,
  role: RequestDbRole,
  autocommit?: ReturnType<typeof pipelinedAutocommit>,
): DatabaseRuntime => {
  const tracedPool = tracePool(pool, role, autocommit?.acquire);
  const client = drizzleNodePostgres({
    client: tracedPool,
    relations: relationalSchema,
    paramsInErrors: true,
  });
  return {
    client,
    close: async () => {
      await Promise.all([pool.end(), autocommit?.end()]);
    },
    withConnection: async (fn) => {
      const connection = await acquireTracedConnection(tracedPool, false);
      try {
        return await fn(
          drizzleNodePostgres({
            client: connection,
            relations: relationalSchema,
            paramsInErrors: true,
          }),
        );
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
  nextClientOrdinal?: () => number,
  idleTimeoutMillis?: number,
): DatabaseRuntime => {
  const Client = createDatabaseClientConstructor(role, nextClientOrdinal);
  // Browser reads ride bounded-stale and are autocommit: one of its sockets
  // becomes the pipelined lane, so a read's independent statements share round
  // trips. Strong keeps both sockets for writes and their transactions.
  const autocommit =
    role === "bounded-stale"
      ? pipelinedAutocommit(
          () => new Client({ connectionString, pipeline: true }),
          role,
        )
      : undefined;
  return runtimeForPool(
    new pg.Pool({
      connectionString,
      max: autocommit ? max - 1 : max,
      ...(idleTimeoutMillis !== undefined && { idleTimeoutMillis }),
      Client,
    }),
    role,
    autocommit,
  );
};

async function closeScope(holder: RequestDatabaseRuntimeScope) {
  holder.closed = true;
  const closed = await Promise.allSettled(
    Object.values(holder.runtimes).map((runtime) => runtime.close?.()),
  );
  for (const result of closed) {
    if (result.status === "rejected")
      log.error("Failed closing database pool", { error: result.reason });
  }
}

/**
 * Run a request with per-request strong and bounded-stale database bindings.
 * Pool construction remains lazy: requests that never resolve a Database
 * handle never create a local pg pool or wake the origin database. The pools
 * close once the response body finishes (or the handler throws) and every
 * `waitUntil` task the request registered has settled; an upgraded socket
 * keeps pg's idle timeout instead.
 */
export const withRequestDb = async (
  connections: RequestDbConnections,
  fn: () => Promise<Response>,
): Promise<Response> => {
  const holder: RequestDatabaseRuntimeScope = {
    kind: "http",
    connections,
    runtimes: {},
  };
  let response: Response;
  try {
    response = await requestDbStore.run(holder, fn);
  } catch (error) {
    // A handler that failed may still have registered waitUntil tasks using
    // these pools: close after they settle, and surface the original error.
    if (!afterExecutionTasks(Promise.resolve(), () => closeScope(holder)))
      await closeScope(holder);
    throw error;
  }
  if (response.status === 101) return response;
  const finished = Promise.withResolvers<void>();
  if (!afterExecutionTasks(finished.promise, () => closeScope(holder)))
    return response;
  return observeResponseBody(response, () => finished.resolve());
};

/**
 * Background work leases clients through HYPERDRIVE_BACKGROUND inside a
 * Worker; non-Worker tests/scripts use the supplied connection string. A
 * standalone client cannot isolate concurrent transactions by serializing
 * individual statements. One invocation holds one pool, closed when it
 * finishes; a nested call (a Durable Object service invoked inline from a
 * queue permit) reuses the open scope instead of opening a second pool.
 */
export const withInvocationDb = async <T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const active = requestDbStore.getStore();
  if (active && !active.closed) return fn();
  const invocationConnection =
    getBackgroundDatabaseConnectionString() ?? connectionString;
  const holder: RequestDatabaseRuntimeScope = {
    kind: "background",
    connections: {
      strong: invocationConnection,
      boundedStale: invocationConnection,
    },
    runtimes: {},
  };
  try {
    return await requestDbStore.run(holder, fn);
  } finally {
    await closeScope(holder);
  }
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

const strongDatabase = createDatabase(() => runtimeResolver.resolve("strong"));
export const db = strongDatabase;

/** Explicitly approved briefly stale reads use the request's stale binding. */
export const boundedStaleDb = isCFWorkers
  ? createDatabase(() => runtimeResolver.resolve("bounded-stale"))
  : strongDatabase;

/**
 * Better Auth needs Drizzle's query-builder methods at configuration time.
 * These concrete getters bind each operation to the current strong request
 * client when Better Auth actually invokes it; no dynamic property proxy is
 * involved, and the supplied auth schema means it never reads Drizzle `_`.
 */
export const drizzle = {
  get select() {
    const client = resolveDatabaseRuntime(strongDatabase).client;
    return client.select.bind(client);
  },
  get insert() {
    const client = resolveDatabaseRuntime(strongDatabase).client;
    return client.insert.bind(client);
  },
  get update() {
    const client = resolveDatabaseRuntime(strongDatabase).client;
    return client.update.bind(client);
  },
  get delete() {
    const client = resolveDatabaseRuntime(strongDatabase).client;
    return client.delete.bind(client);
  },
  get transaction() {
    const client = resolveDatabaseRuntime(strongDatabase).client;
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
  resolveDatabaseRuntime(database).withConnection(async (client) => {
    const runtime = runtimeForClient(client);
    return await fn(createDatabase(() => runtime));
  });

export type DrizzleClient = DatabaseClient;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
