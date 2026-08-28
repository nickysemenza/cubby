import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import * as schema from "../../src/server/db/schema";
import { ensureDbExtensions } from "../../tooling/db-extensions";

export type E2EDatabaseKind = "pglite" | "postgres";

export interface E2EDatabase {
  kind: E2EDatabaseKind;
  databaseUrl: string;
  close(): Promise<void>;
}

interface SchemaDatabase {
  execute(query: SQL): Promise<unknown>;
}

const PGLITE_HOST = "127.0.0.1";
const PGLITE_MAX_CONNECTIONS = 16;

function resolveE2EDatabaseKind(
  env: NodeJS.ProcessEnv = process.env,
): E2EDatabaseKind {
  const configured = env.CUBBY_E2E_DATABASE;
  if (configured === "pglite" || configured === "postgres") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Unsupported CUBBY_E2E_DATABASE=${configured}; expected pglite or postgres`,
    );
  }
  return env.CI ? "postgres" : "pglite";
}

async function pushE2ESchema(db: SchemaDatabase): Promise<void> {
  // drizzle-kit is deliberately loaded only in global setup. It is large and
  // none of the Playwright workers need it after the schema has been prepared.
  const { pushSchema } = await import("drizzle-kit/api");

  await ensureDbExtensions(db);
  const { apply } = await pushSchema(
    schema,
    db as unknown as Parameters<typeof pushSchema>[1],
    ["public"],
  );
  await apply();
}

async function seedHome(db: SchemaDatabase): Promise<void> {
  // The application requires exactly one real hierarchy root. Keep this in the
  // checked-out database rather than the IntegreSQL template so a cached older
  // template is repaired and both providers start from the same application
  // state.
  await db.execute(sql`
    INSERT INTO "Location" (shortcode, name, aliases, tags, type, "parentId")
    VALUES ('LOC-HM3E', 'Home', ARRAY[]::text[], ARRAY[]::text[], 'house', NULL)
  `);
}

function remapIntegreSQLConfig(
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig {
  return {
    ...databaseConfig,
    host: process.env.INTEGRESQL_DATABASE_HOST ?? "localhost",
    port: 5432,
  };
}

async function createPostgresE2EDatabase(): Promise<E2EDatabase> {
  const integreSQL = new IntegreSQLClient({
    url: process.env.INTEGRESQL_URL ?? "http://localhost:5000",
  });

  console.log("[E2E Setup] Getting fresh database from IntegreSQL...");
  const hash = await integreSQL.hashFiles([
    "./src/server/db/schema.ts",
    "./src/server/db/auth.schema.ts",
  ]);

  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapIntegreSQLConfig(databaseConfig),
    );
    const pool = new Pool({ connectionString: connectionUrl });
    try {
      console.log("[E2E Setup] Pushing schema to PostgreSQL template...");
      await pushE2ESchema(drizzleNodePostgres(pool));
      console.log("[E2E Setup] PostgreSQL template schema pushed");
    } finally {
      await pool.end();
    }
  });

  const databaseConfig = await integreSQL.getTestDatabase(hash);
  const databaseUrl = integreSQL.databaseConfigToConnectionUrl(
    remapIntegreSQLConfig(databaseConfig),
  );
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    await seedHome(drizzleNodePostgres(seedPool));
  } finally {
    await seedPool.end();
  }

  console.log(
    `[E2E Setup] Using PostgreSQL database: ${databaseConfig.database}`,
  );
  return {
    kind: "postgres",
    databaseUrl,
    // IntegreSQL owns the cloned database lifecycle and recreates its test pool
    // between runs; there is no client kept open by this provider.
    async close() {},
  };
}

async function createPGliteE2EDatabase(): Promise<E2EDatabase> {
  console.log("[E2E Setup] Creating in-memory PGlite database...");
  const pg = await PGlite.create({ extensions: { pg_trgm, vector } });
  let socketServer: PGLiteSocketServer | undefined;

  try {
    const db = drizzlePGlite(pg, { schema });
    await pushE2ESchema(db);
    await seedHome(db);

    socketServer = new PGLiteSocketServer({
      db: pg,
      host: PGLITE_HOST,
      port: 0,
      // The Worker, Hyperdrive bindings, and server-side fixtures each retain
      // pools. PGlite still serializes their queries internally; this limit
      // only prevents those retained clients from being rejected.
      maxConnections: PGLITE_MAX_CONNECTIONS,
    });
    await socketServer.start();

    const databaseUrl = `postgresql://postgres:postgres@${socketServer.getServerConn()}/postgres`;
    console.log(
      `[E2E Setup] PGlite socket database is ready at ${socketServer.getServerConn()}`,
    );

    let closed = false;
    return {
      kind: "pglite",
      databaseUrl,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await socketServer?.stop();
        } finally {
          await pg.close();
        }
      },
    };
  } catch (error) {
    try {
      await socketServer?.stop();
    } finally {
      await pg.close();
    }
    throw error;
  }
}

export function createE2EDatabase(
  kind = resolveE2EDatabaseKind(),
): Promise<E2EDatabase> {
  return kind === "pglite"
    ? createPGliteE2EDatabase()
    : createPostgresE2EDatabase();
}
