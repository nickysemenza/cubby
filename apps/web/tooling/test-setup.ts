import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { unsafeProjectId } from "../src/schemas/identifiers";
import { type Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await integreSQL.hashFiles(["./src/server/db/schema.ts"]);

  // Initialize the template database
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("Migrating template database");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);

    await migrate(db, { migrationsFolder: "./drizzle" });

    console.log("Template database migrated");
    await pool.end();
  });
}
export async function buildTestDB() {
  const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });
  const hash = await integreSQL.hashFiles(["./src/server/db/schema.ts"]);
  const databaseConfig = await integreSQL.getTestDatabase(hash);
  console.log("testdb:", databaseConfig.database);
  const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );

  // Create drizzle client directly without importing from db.ts
  const pool = new Pool({ connectionString: connectionUrl });
  const rawDb = drizzle({ client: pool, schema });

  // Automatically create a test project
  const testProject = await rawDb
    .insert(schema.project)
    .values({
      name: "Test Project",
      description: "Auto-created project for testing",
    })
    .returning()
    .then((rows) => rows[0]!);

  const teardown = async () => {
    await pool.end();
  };

  return {
    db: rawDb as unknown as Database,
    projectId: unsafeProjectId(testProject.id),
    teardown,
  };
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  if (process.env.DATABASE_URL?.includes("5555")) {
    databaseConfig.port = 5555;
  }
  return databaseConfig;
};
