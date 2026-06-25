import { AsyncLocalStorage } from "node:async_hooks";
import {
  drizzle as drizzleNodePostgres,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "~/env";
import type { Database } from "./db/database";
import * as schema from "./db/schema";
import { TraceNames, withTrace } from "./tracing";

// Re-export Database type for use throughout the application
export type { Database };

// ---------------------------------------------------------------------------
// DB Client creation
// ---------------------------------------------------------------------------

// The query interface is identical whether backed by Client or Pool.
// Use NodePgDatabase<schema> to avoid $client type mismatch.
type DBClient = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// DB query tracing
// ---------------------------------------------------------------------------

// Trace every drizzle query as a span via the unified `withTrace` (OTel → Jaeger
// in dev, native `cloudflare:workers` tracing → Grafana in prod). This replaces
// @kubiks/otel-drizzle, which emits ONLY OTel spans — a no-op on the prod Worker
// (no OTel SDK), so DB time was invisible in CF traces: a slow query showed only
// as unattributed gap inside the tRPC span. We now get real per-query timing
// (incl. the first query's connection-establishment cost, since pg.Pool connects
// lazily) plus the statement + row count, in BOTH runtimes.
const TRACED = Symbol("worker-tracing:traced");
const DB_SYSTEM = "postgresql";
const DB_NAMESPACE = "cubby";
const MAX_STATEMENT_LEN = 1000;

// The SQL operation = the leading keyword (SELECT/INSERT/UPDATE/DELETE/BEGIN/…),
// uppercased. This is exactly how @kubiks/otel-drizzle derives db.operation — it
// reads the compiled SQL text, NOT the drizzle query builder (it extracts no
// table name and pulls db.name/peer from caller config), so there's nothing the
// pg layer can't see. That's why we don't patch drizzle internals.
const extractOperation = (sql: string): string | undefined =>
  /^\s*(\w+)/u.exec(sql)?.[1]?.toUpperCase();

// Wrap one pg `query` function (a checked-out Client's `query`) in a `withTrace`
// span. `getTransaction` is read at query time — a checked-out client is reused
// across checkouts, so transaction-ness is per-acquire, not per-client.
const traceQuery =
  (run: (...args: unknown[]) => unknown, getTransaction: () => boolean) =>
  (...args: unknown[]): unknown => {
    // pg's `query` has callback overloads; only the promise form (what drizzle
    // uses) is traced. No args, or a trailing callback → pass straight through.
    if (args.length === 0 || typeof args[args.length - 1] === "function")
      return run(...args);
    const head = args[0];
    const sql =
      typeof head === "string"
        ? head
        : head && typeof head === "object" && "text" in head
          ? String((head as { text: unknown }).text)
          : "unknown";
    const operation = extractOperation(sql);
    // Span name per operation (db.SELECT, db.INSERT, …) + OTel DB semconv attrs —
    // the same information @kubiks/otel-drizzle emits, in BOTH runtimes.
    return withTrace(TraceNames.db(operation ?? "query"), async (span) => {
      span.setAttributes({
        "db.system.name": DB_SYSTEM,
        "db.namespace": DB_NAMESPACE,
        "db.operation.name": operation,
        "db.query.text": sql.slice(0, MAX_STATEMENT_LEN),
        "db.query.transaction": getTransaction(),
      });
      const res = (await run(...args)) as {
        rowCount?: number | null;
        rows?: unknown[];
      };
      span.setAttribute(
        "db.response.returned_rows",
        res?.rowCount ?? res?.rows?.length ?? 0,
      );
      return res;
    });
  };

// Trace BOTH the connection acquire AND the query. Routing every query through an
// explicit acquire (instead of letting pg.Pool.query connect internally) surfaces
// the connection cost as its own `db.acquire` span rather than folding it into the
// first query's span — the per-request pool connects lazily, so the first acquire
// pays the full TCP/TLS/auth round-trip to Hyperdrive→Neon. That separation is the
// signal we need to tell "connection: 5s" apart from "query: 7ms".
const IN_TX = Symbol("worker-tracing:inTransaction");
type TracedClient = pg.PoolClient & { [TRACED]?: boolean; [IN_TX]?: boolean };

// Exposes the traced `acquire` on the pool so a non-transaction checkout (e.g.
// withConnection) can request transaction:false — pool.connect() always stamps
// transaction:true via the override below, which would mislabel the spans.
const ACQUIRE = Symbol("worker-tracing:acquire");
type TracedPool = pg.Pool & {
  [ACQUIRE]?: (inTransaction: boolean) => Promise<pg.PoolClient>;
};

const tracePool = (pool: pg.Pool): pg.Pool => {
  const rawQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const rawConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  // Acquire a client inside a `db.acquire` span and wrap its `query` once. The
  // transaction flag is stamped per-acquire so a reused client reports correctly.
  const acquire = (inTransaction: boolean): Promise<pg.PoolClient> =>
    withTrace(TraceNames.db("acquire"), async (span) => {
      span.setAttribute("db.acquire.transaction", inTransaction);
      const client = (await rawConnect()) as TracedClient;
      client[IN_TX] = inTransaction;
      if (!client[TRACED]) {
        client.query = traceQuery(
          client.query.bind(client),
          () => client[IN_TX] ?? false,
        ) as typeof client.query;
        client[TRACED] = true;
      }
      return client;
    });

  // Non-transactional queries: acquire (traced) → query (traced) → release. The
  // callback / no-arg forms (incl. pg's own internal usage) pass straight through.
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

  // Transactions (drizzle `.transaction()`) check out a client via connect.
  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === "function") return rawConnect(...args); // callback form
    return acquire(true);
  }) as typeof pool.connect;

  // Expose the traced acquire for non-transaction single-connection checkouts.
  (pool as TracedPool)[ACQUIRE] = acquire;

  return pool;
};

const createPoolClient = (connectionString: string) => {
  const { Pool } = pg;
  // Dev-only pool (prod uses a per-request pg.Pool behind Hyperdrive — see
  // getDbInstance; Node has no Workers connection limit, so dev can run wide).
  // The Problems page fans out ~25 concurrent queries; pg's default max of 10 forces
  // the overflow to queue and pay fresh ~310ms TLS handshakes to Neon, so lift
  // the ceiling enough to absorb the fan-out.
  const pool = new Pool({ connectionString, max: 25 });
  return drizzleNodePostgres({ client: tracePool(pool), schema });
};

// ---------------------------------------------------------------------------
// CF Workers: per-request Pool via AsyncLocalStorage
// Hyperdrive pools TCP connections to the origin at CF's edge. A single
// pg.Client per request would serialize every query on ONE connection — the
// Problems page fans out ~12 detectors, turning a parallel scan into a ~12s
// sum-of-all-queries. We use a small per-request pg.Pool instead (max 5, the
// Workers per-invocation connection ceiling — see getDbInstance), giving the
// fan-out bounded real concurrency (wall time ≈ slowest few queries, not the sum).
// ---------------------------------------------------------------------------

// Per-request holder. We store the connection string (not a connected pool) so
// the actual pg.Pool is deferred until the first db access — see
// getDbInstance(). Requests that never query (static pages, logged-out / and
// /auth/sign-in, bot 404s) never open a Neon connection.
type LazyDbHolder = {
  connectionString: string;
  db?: DBClient;
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
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  return requestDbStore.run({ connectionString }, fn);
};

// ---------------------------------------------------------------------------
// Module-level instance (dev server only — NOT used on CF Workers)
// ---------------------------------------------------------------------------

// __CF_WORKERS__ is defined by Vite for CF builds — skip module-level pool
declare const __CF_WORKERS__: boolean | undefined;
const isCFWorkers =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

let moduleDb: DBClient | undefined;

if (!isCFWorkers) {
  const globalForDb = globalThis as unknown as { db: DBClient | undefined };
  moduleDb = globalForDb.db ?? createPoolClient(env.DATABASE_URL);
  if (env.NODE_ENV !== "production") globalForDb.db = moduleDb;
}

// ---------------------------------------------------------------------------
// Exported db / drizzle — uses AsyncLocalStorage on CF, module instance in dev
// ---------------------------------------------------------------------------

const getDbInstance = (): DBClient => {
  // CF Workers: read from per-request store, connecting lazily on first access.
  const holder = requestDbStore.getStore();
  if (holder) {
    if (!holder.db) {
      // Per-request Pool: connections are opened lazily on demand (up to `max`)
      // and concurrent queries each grab their own, so a fan-out runs in
      // parallel instead of serializing on one connection. Drizzle's
      // .transaction() checks out a single dedicated client for its duration, so
      // transactional atomicity is preserved; only independent queries spread.
      //
      // max:5 is Cloudflare's recommended ceiling for a per-request DB pool: a
      // Worker invocation can hold at most ~6 simultaneous outbound TCP
      // connections, and Hyperdrive client connections count against that limit.
      // (This is NOT the Hyperdrive→origin pool size of 60 — that's shared
      // across all invocations and protects the database, not this request.) So
      // the Problems fan-out gets 5-way parallelism, the platform maximum.
      //
      // We deliberately never call pool.end() — Hyperdrive manages connection
      // lifecycle, and httpBatchStreamLink streams the response before all
      // batched procedures finish. A Pool makes that safe for free: an in-flight
      // (still-streaming) query keeps its client checked out and never idle, so
      // it's never closed under it, while a finished query returns its client to
      // the pool to self-drain via the idle timeout. allowExitOnIdle lets idle
      // clients close without keeping the isolate alive.
      const pool = new pg.Pool({
        connectionString: holder.connectionString,
        max: 5,
        allowExitOnIdle: true,
      });
      const db = drizzleNodePostgres({ client: tracePool(pool), schema });
      holder.db = db;
    }
    return holder.db;
  }
  // Dev server: use module-level instance
  if (moduleDb) return moduleDb;
  throw new Error(
    "No database instance available. On CF Workers, wrap the handler with withRequestDb().",
  );
};

// Proxy that delegates all property access to the current per-request instance.
// This allows `db` to be a module-level constant while being request-scoped on CF.
const dbProxy = new Proxy({} as DBClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getDbInstance(), prop, receiver);
  },
});

/**
 * Convert a Drizzle client instance to the opaque Database type.
 * This brands the client to enforce that direct database access only happens in repo files.
 * Use this when creating Database instances (e.g., in test setup).
 */
const toBrandedDatabase = (client: DBClient): Database => {
  return client as unknown as Database;
};

// Export the branded instance - NO methods can be called on this outside repo/
export const db = toBrandedDatabase(dbProxy);

// Export the raw Drizzle client for integrations that require direct access
// (e.g., Better‑Auth drizzle adapter). Do not use this for app queries.
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
  // DBClient is typed as NodePgDatabase<schema> (which hides `$client` to avoid
  // a type mismatch — see top of file), but the runtime instance always carries
  // the traced pg.Pool as `$client`. Cast through the known runtime shape.
  const pool = (db as unknown as { $client: TracedPool }).$client;
  // Read-only checkout → transaction:false spans. Fall back to the (transaction-
  // labelled) connect only if the pool somehow wasn't traced.
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
