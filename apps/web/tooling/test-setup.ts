import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { unsafeOrganizationId } from "../src/schemas/identifiers";
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

  // Automatically create a test organization
  const testOrg = await rawDb
    .insert(schema.organization)
    .values({
      id: "test-org-id",
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  const teardown = async () => {
    await pool.end();
  };

  return {
    db: rawDb as unknown as Database,
    organizationId: unsafeOrganizationId(testOrg.id),
    teardown,
  };
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  // Always use port 5555 (mapped from container's 5432)
  databaseConfig.port = 5555;
  return databaseConfig;
};
