import {
  instrumentDrizzle,
  instrumentDrizzleClient,
} from "@kubiks/otel-drizzle";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "~/env";
import type { Database } from "./db/database";
import * as schema from "./db/schema";

// Use the native WebSocket global (Node 22+) to avoid ws native addon
// bundling issues on Vercel (bufferUtil.mask is not a function)
neonConfig.webSocketConstructor = WebSocket;
// Pipeline startup+auth messages to save 1-2 round trips per new connection
neonConfig.pipelineConnect = "password";
// Batch multiple protocol messages into single WebSocket frames
neonConfig.coalesceWrites = true;
// Skip redundant Postgres-level TLS inside the already-encrypted wss:// tunnel
neonConfig.forceDisablePgSSL = true;

// Re-export Database type for use throughout the application
export type { Database };

const createDBClient = (connectionString: string) => {
  if (connectionString.includes("neon.tech")) {
    // Use Neon WebSocket pool for serverless environments (supports transactions)
    const pool = new NeonPool({ connectionString });
    const db = drizzleNodePostgres({ client: pool, schema });
    instrumentDrizzleClient(db, { dbSystem: "postgresql", dbName: "cubby" });
    return db;
  } else {
    // Use standard node-postgres for traditional PostgreSQL connections
    const pool = new Pool({ connectionString });
    const instrumentedPool = instrumentDrizzle(pool);
    return drizzleNodePostgres({ client: instrumentedPool, schema });
  }
};

const globalForDb = globalThis as unknown as {
  db: ReturnType<typeof createDBClient> | undefined;
};

const dbInstance = globalForDb.db ?? createDBClient(env.DATABASE_URL);

if (env.NODE_ENV !== "production") globalForDb.db = dbInstance;

/**
 * Convert a Drizzle client instance to the opaque Database type.
 * This brands the client to enforce that direct database access only happens in repo files.
 * Use this when creating Database instances (e.g., in test setup).
 */
const toBrandedDatabase = (
  client: ReturnType<typeof createDBClient>,
): Database => {
  return client as unknown as Database;
};

// Export the branded instance - NO methods can be called on this outside repo/
export const db = toBrandedDatabase(dbInstance);

// Export the raw Drizzle client for integrations that require direct access
// (e.g., Better‑Auth drizzle adapter). Do not use this for app queries.
export const drizzle = dbInstance;

// Type for Drizzle transaction client
export type DrizzleClient = ReturnType<typeof createDBClient>;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
