import { AsyncLocalStorage } from "node:async_hooks";
import {
  instrumentDrizzle,
  instrumentDrizzleClient,
} from "@kubiks/otel-drizzle";
import { Client as NeonClient, neonConfig } from "@neondatabase/serverless";
import {
  drizzle as drizzleNodePostgres,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { env } from "~/env";
import type { Database } from "./db/database";
import * as schema from "./db/schema";

// Use the native WebSocket global (Node 22+, CF Workers) to avoid ws native
// addon bundling issues on Vercel (bufferUtil.mask is not a function)
neonConfig.webSocketConstructor = WebSocket;
// Pipeline startup+auth messages to save 1-2 round trips per new connection
neonConfig.pipelineConnect = "password";
// Batch multiple protocol messages into single WebSocket frames
neonConfig.coalesceWrites = true;
// Skip redundant Postgres-level TLS inside the already-encrypted wss:// tunnel
neonConfig.forceDisablePgSSL = true;

// Re-export Database type for use throughout the application
export type { Database };

// ---------------------------------------------------------------------------
// DB Client creation
// ---------------------------------------------------------------------------

const createNeonClient = (connectionString: string) => {
  const client = new NeonClient({ connectionString });
  const db = drizzleNodePostgres({ client, schema });
  instrumentDrizzleClient(db, { dbSystem: "postgresql", dbName: "cubby" });
  return { client, db };
};

// The query interface is identical whether backed by Client or Pool.
// Use NodePgDatabase<schema> to avoid $client type mismatch.
type DBClient = NodePgDatabase<typeof schema>;

const createPoolClient = async (connectionString: string) => {
  if (connectionString.includes("neon.tech")) {
    // NeonPool extends pg.Pool — works over WebSocket, ideal for long-lived processes
    const { Pool: NeonPool } = await import("@neondatabase/serverless");
    const pool = new NeonPool({ connectionString });
    const db = drizzleNodePostgres({ client: pool, schema });
    instrumentDrizzleClient(db, { dbSystem: "postgresql", dbName: "cubby" });
    return db;
  }
  // Standard node-postgres for traditional PostgreSQL connections
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const instrumentedPool = instrumentDrizzle(pool);
  return drizzleNodePostgres({ client: instrumentedPool, schema });
};

// ---------------------------------------------------------------------------
// CF Workers: per-request Client via AsyncLocalStorage
// In Workers, WebSocket connections are bound to the request that created them.
// We create a fresh NeonClient per request and store it in AsyncLocalStorage.
// ---------------------------------------------------------------------------

const requestDbStore = new AsyncLocalStorage<DBClient>();

/**
 * Run a function with a per-request database connection (CF Workers only).
 * Creates a fresh NeonClient, connects it, runs the handler, then disconnects.
 */
export const withRequestDb = async <T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const { client, db: dbClient } = createNeonClient(connectionString);
  await client.connect();
  // Don't call client.end() — CF Workers cleans up request-scoped WebSockets
  // automatically. Closing early causes "Can't call WebSocket send() after close()"
  // errors when queries are still in-flight (e.g., streaming SSR responses).
  return requestDbStore.run(dbClient, fn);
};

// ---------------------------------------------------------------------------
// Module-level instance (Vercel / node-server only — NOT used on CF Workers)
// ---------------------------------------------------------------------------

// __CF_WORKERS__ is defined by Vite for CF builds — skip module-level pool
declare const __CF_WORKERS__: boolean | undefined;
const isCFWorkers =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

let moduleDb: DBClient | undefined;

if (!isCFWorkers) {
  const globalForDb = globalThis as unknown as { db: DBClient | undefined };
  moduleDb = globalForDb.db ?? (await createPoolClient(env.DATABASE_URL));
  if (env.NODE_ENV !== "production") globalForDb.db = moduleDb;
}

// ---------------------------------------------------------------------------
// Exported db / drizzle — uses AsyncLocalStorage on CF, module instance otherwise
// ---------------------------------------------------------------------------

const getDbInstance = (): DBClient => {
  // CF Workers: read from per-request store
  const requestDb = requestDbStore.getStore();
  if (requestDb) return requestDb;
  // Vercel / node-server: use module-level instance
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
