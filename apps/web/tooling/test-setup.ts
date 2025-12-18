import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { unsafeOrganizationId, unsafeUserId } from "../src/schemas/identifiers";
import { type Database } from "../src/server/db/database";
import { type ActorContext } from "../src/schemas/context";
import * as schema from "../src/server/db/schema";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

// Standard test IDs used across all tests
export const TEST_ORG_ID = "test-org-id";
export const TEST_USER_ID = "test-user-id";

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

  // Automatically create a test user
  await rawDb
    .insert(schema.user)
    .values({
      id: TEST_USER_ID,
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  // Automatically create a test organization
  const testOrg = await rawDb
    .insert(schema.organization)
    .values({
      id: TEST_ORG_ID,
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  // Create member relationship between user and org
  await rawDb.insert(schema.organizationMember).values({
    id: "test-member-id",
    userId: TEST_USER_ID,
    organizationId: TEST_ORG_ID,
    role: "owner",
    createdAt: new Date(),
  });

  const teardown = async () => {
    await pool.end();
  };

  const actor: ActorContext = {
    userId: unsafeUserId(TEST_USER_ID),
    organizationId: unsafeOrganizationId(testOrg.id),
    source: "ui",
  };

  return {
    db: rawDb as unknown as Database,
    organizationId: unsafeOrganizationId(testOrg.id),
    actor,
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
