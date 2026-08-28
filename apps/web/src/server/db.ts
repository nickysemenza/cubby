import { AsyncLocalStorage } from "node:async_hooks";

import {
  drizzle as drizzleNodePostgres,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "~/env";
import { databaseStatementForTrace } from "~/lib/db-query-telemetry";

import { beginDatabaseAcquire, beginDatabaseQuery } from "./db-observability";
import type { Database } from "./db/database";
import * as schema from "./db/schema";
import { TraceNames, withTrace } from "./tracing";

// Re-export Database type for use throughout the application
export type { Database };

type DBClient = NodePgDatabase<typeof schema>;

const TRACED = Symbol("worker-tracing:traced");
const DB_SYSTEM = "postgresql";
const DB_NAMESPACE = "cubby";

const extractOperation = (sql: string): string | undefined =>
  /^\s*(\w+)/u.exec(sql)?.[1]?.toUpperCase();

type RequestDbRole = "strong" | "bounded-stale";

const traceQuery =
  (
    run: (...args: unknown[]) => unknown,
    getTransaction: () => boolean,
    role: RequestDbRole,
  ) =>
  (...args: unknown[]): unknown => {
    if (args.length === 0 || typeof args[args.length - 1] === "function")
      return run(...args);
    const sql = databaseStatementForTrace(args[0]);
    const operation = extractOperation(sql);
    return withTrace(TraceNames.db(operation ?? "query"), async (span) => {
      // Hottest span in the app — every query goes through here. Gate the
      // attribute work on sampling so an unsampled request doesn't pay to slice
      // a statement nobody will export. No-op while the Worker runs
      // head_sampling_rate: 1; the point is that lowering it stays a wrangler
      // edit rather than a code change.
      if (span.isRecording) {
        span.setAttributes({
          "db.system.name": DB_SYSTEM,
          "db.namespace": DB_NAMESPACE,
          "db.operation.name": operation,
          "db.query.text": sql,
          "db.query.transaction": getTransaction(),
          "cubby.db.binding_role": role,
        });
      }
      const finishQuery = beginDatabaseQuery();
      try {
        const res = (await run(...args)) as {
          rowCount?: number | null;
          rows?: unknown[];
        };
        span.setAttribute(
          "db.response.returned_rows",
          res?.rowCount ?? res?.rows?.length ?? 0,
        );
        return res;
      } finally {
        finishQuery();
      }
    });
  };

const IN_TX = Symbol("worker-tracing:inTransaction");
type TracedClient = pg.PoolClient & { [TRACED]?: boolean; [IN_TX]?: boolean };
type TracedStandaloneClient = pg.Client & {
  [TRACED]?: boolean;
  [IN_TX]?: boolean;
};

const ACQUIRE = Symbol("worker-tracing:acquire");
type TracedPool = pg.Pool & {
  [ACQUIRE]?: (inTransaction: boolean) => Promise<pg.PoolClient>;
};

const tracePool = (pool: pg.Pool, role: RequestDbRole): pg.Pool => {
  const rawQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const rawConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  const acquire = (inTransaction: boolean): Promise<pg.PoolClient> =>
    withTrace(TraceNames.db("acquire"), async (span) => {
      span.setAttribute("db.acquire.transaction", inTransaction);
      const t0 = performance.now();
      const finishAcquire = beginDatabaseAcquire(t0);
      try {
        const client = (await rawConnect()) as TracedClient;
        const ms = Math.round(performance.now() - t0);
        span.setAttribute("db.acquire.duration_ms", ms);
        if (ms > 500) {
          console.warn(
            `[db-acquire] transaction=${inTransaction} duration_ms=${ms}`,
          );
        }
        client[IN_TX] = inTransaction;
        if (!client[TRACED]) {
          client.query = traceQuery(
            client.query.bind(client),
            () => client[IN_TX] ?? false,
            role,
          ) as typeof client.query;
          client[TRACED] = true;
        }
        return client;
      } finally {
        finishAcquire();
      }
    });

  pool.query = ((...args: unknown[]) => {
    if (args.length === 0 || typeof args[args.length - 1] === "function")
      return rawQuery(...args);
    return acquire(false).then(async (client) => {
      try {
        return await (client.query as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
      } finally {
        client.release();
      }
    });
  }) as typeof pool.query;

  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === "function") return rawConnect(...args); // callback form
    return acquire(true);
  }) as typeof pool.connect;

  (pool as TracedPool)[ACQUIRE] = acquire;

  return pool;
};

const traceStandaloneClient = (
  client: pg.Client,
  role: RequestDbRole,
): pg.Client => {
  const traced = client as TracedStandaloneClient;
  traced[IN_TX] = false;
  if (!traced[TRACED]) {
    traced.query = traceQuery(
      traced.query.bind(traced),
      () => traced[IN_TX] ?? false,
      role,
    ) as typeof traced.query;
    traced[TRACED] = true;
  }
  return client;
};

const createPoolClient = (connectionString: string) => {
  const { Pool } = pg;
  const pool = new Pool({ connectionString, max: 25 });
  return drizzleNodePostgres({ client: tracePool(pool, "strong"), schema });
};

export type RequestDbConnections = {
  strong: string;
  boundedStale: string;
};

type LazyDbHolder = {
  connections: RequestDbConnections;
  clients: Partial<Record<RequestDbRole, DBClient>>;
};

const requestDbStore = new AsyncLocalStorage<LazyDbHolder>();

/**
 * Run a function with a per-request database connection (CF Workers only).
 * Uses a per-request pg.Pool through Hyperdrive's pooled TCP connections.
 *
 * Lazy: this does NOT connect. The connection is opened on first db access
 * inside getDbInstance(), so requests that never query never wake Neon.
 */
export const withRequestDb = async <T>(
  connections: RequestDbConnections,
  fn: () => Promise<T>,
): Promise<T> => {
  const holder: LazyDbHolder = { connections, clients: {} };
  return requestDbStore.run(holder, fn);
};

/**
 * Queue-only DB scope: one Worker-side pg.Client for the whole queue invocation.
 * Hyperdrive still owns the origin DB pool; this only avoids a local pg.Pool for
 * serial queue work. We intentionally do not call client.end() here: the client
 * is not reused across invocations, and Hyperdrive/Workers own the edge socket
 * lifecycle once the handler settles.
 */
export const withRequestDbClient = async <T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const client = traceStandaloneClient(
    new pg.Client({ connectionString }),
    "strong",
  );
  const t0 = performance.now();
  await withTrace(TraceNames.db("connect"), async (span) => {
    await client.connect();
    span.setAttributes({
      "db.system.name": DB_SYSTEM,
      "db.namespace": DB_NAMESPACE,
      "db.connect.duration_ms": Math.round(performance.now() - t0),
    });
  });
  const holder: LazyDbHolder = {
    connections: { strong: connectionString, boundedStale: connectionString },
    clients: { strong: drizzleNodePostgres({ client, schema }) },
  };
  return requestDbStore.run(holder, fn);
};

declare const __CF_WORKERS__: boolean | undefined;
const isCFWorkers =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

let moduleDb: DBClient | undefined;

if (!isCFWorkers) {
  const globalForDb = globalThis as unknown as { db: DBClient | undefined };
  moduleDb = globalForDb.db ?? createPoolClient(env.DATABASE_URL);
  if (env.NODE_ENV !== "production") globalForDb.db = moduleDb;
}

const requestPoolLimit = (role: RequestDbRole): number =>
  role === "strong" ? 5 : 1;

const getDbInstance = (role: RequestDbRole): DBClient => {
  const holder = requestDbStore.getStore();
  if (holder) {
    const existing = holder.clients[role];
    if (existing) return existing;
    // Keep the per-request pool within the Worker connection ceiling.
    // Auth and authoritative work may use five strong sockets; bounded-stale
    // reads get one more socket so both adapters together stay at six.
    // Hyperdrive owns lifecycle and timeouts; do not add session overrides.
    const pool = new pg.Pool({
      connectionString:
        role === "strong"
          ? holder.connections.strong
          : holder.connections.boundedStale,
      max: requestPoolLimit(role),
    });
    const client = drizzleNodePostgres({
      client: tracePool(pool, role),
      schema,
    });
    holder.clients[role] = client;
    return client;
  }
  if (moduleDb) return moduleDb;
  throw new Error(
    "No database instance available. On CF Workers, wrap the handler with withRequestDb().",
  );
};

const createDbProxy = (role: RequestDbRole): DBClient =>
  new Proxy({} as DBClient, {
    get(_target, prop, receiver) {
      return Reflect.get(getDbInstance(role), prop, receiver);
    },
  });

const dbProxy = createDbProxy("strong");
const boundedStaleDbProxy = isCFWorkers
  ? createDbProxy("bounded-stale")
  : dbProxy;

const toBrandedDatabase = (client: DBClient): Database => {
  return client as unknown as Database;
};

export const db = toBrandedDatabase(dbProxy);

/**
 * Request-scoped adapter for explicitly approved briefly stale reads.
 * Non-Worker environments deliberately share the strong module database.
 */
export const boundedStaleDb = toBrandedDatabase(boundedStaleDbProxy);

/** Raw client for integrations; application queries use the branded `db`. */
export const drizzle = dbProxy;

/**
 * Run `fn` with a Database bound to ONE checked-out connection, so a fan-out of
 * independent read queries shares a single `db.acquire` instead of each
 * contending for a pool slot. The per-request pool is max:5, but the Problems
 * "fast" group fires 8 detectors at once — 5 cold connects + 3 queued, all
 * acquire-bound while the SELECTs are ~0ms. Pinning them to one client trades 8
 * connects for 1; the queries serialize on the wire (one in-flight query per
 * connection), which is free when each is instant.
 *
 * Unlike withTransaction this issues NO BEGIN/COMMIT — the detectors are
 * read-only and need no snapshot. The single `db.acquire` span (and the query
 * spans under it) are honestly labelled transaction:false via the traced
 * read-only acquire.
 */
export const withConnection = async <T>(
  db: Database,
  fn: (scoped: Database) => Promise<T>,
): Promise<T> => {
  const pool = (db as unknown as { $client: TracedPool }).$client;
  const acquire = pool[ACQUIRE];
  const client = await (acquire ? acquire(false) : pool.connect());
  try {
    const scoped = toBrandedDatabase(drizzleNodePostgres({ client, schema }));
    return await fn(scoped);
  } finally {
    client.release();
  }
};

// Type for Drizzle transaction client
export type DrizzleClient = DBClient;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
