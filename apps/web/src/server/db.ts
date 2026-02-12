import { AsyncLocalStorage } from "node:async_hooks";
import {
  instrumentDrizzle,
  instrumentDrizzleClient,
} from "@kubiks/otel-drizzle";
import {
  drizzle as drizzleNodePostgres,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "~/env";
import type { Database } from "./db/database";
import * as schema from "./db/schema";

// Re-export Database type for use throughout the application
export type { Database };

// ---------------------------------------------------------------------------
// DB Client creation
// ---------------------------------------------------------------------------

// The query interface is identical whether backed by Client or Pool.
// Use NodePgDatabase<schema> to avoid $client type mismatch.
type DBClient = NodePgDatabase<typeof schema>;

const createPoolClient = (connectionString: string) => {
  const { Pool } = pg;
  const pool = new Pool({ connectionString });
  const instrumentedPool = instrumentDrizzle(pool);
  return drizzleNodePostgres({ client: instrumentedPool, schema });
};

// ---------------------------------------------------------------------------
// CF Workers: per-request Client via AsyncLocalStorage
// Hyperdrive pools TCP connections at CF's edge — use pg.Client (not pg.Pool)
// since Hyperdrive itself is the pool. Queries serialize through one connection
// but Hyperdrive caching makes them fast (~5ms for cached reads).
// ---------------------------------------------------------------------------

const requestDbStore = new AsyncLocalStorage<DBClient>();

/**
 * Run a function with a per-request database connection (CF Workers only).
 * Uses pg.Client through Hyperdrive's pooled TCP connections.
 */
export const withRequestDb = async <T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const db = drizzleNodePostgres({ client, schema });
  instrumentDrizzleClient(db, { dbSystem: "postgresql", dbName: "cubby" });
  // No explicit client.end() — Hyperdrive manages connection lifecycle.
  // Calling client.end() can terminate the connection while queries are
  // still queued on the pg.Client (tRPC batches stream responses before
  // all procedures complete).
  return requestDbStore.run(db, fn);
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
  // CF Workers: read from per-request store
  const requestDb = requestDbStore.getStore();
  if (requestDb) return requestDb;
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

// Type for Drizzle transaction client
export type DrizzleClient = DBClient;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
