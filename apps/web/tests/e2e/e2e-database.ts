import { testServiceConfig } from "../../tooling/test-service-config";
import { schemaTemplateInputs } from "../../tooling/schema-template-inputs";
import { taxonomyRootFixtures } from "../../tooling/product-category-fixtures";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/server/db/schema";
import { ensureDbExtensions } from "../../tooling/db-extensions";
import { toPushSchemaDatabase } from "../../tooling/drizzle-kit-interop";

export interface E2EDatabase {
  databaseUrl: string;
  name: string;
  close(): Promise<void>;
}

interface SchemaDatabase {
  readonly _: unknown;
  execute(query: SQL): Promise<object>;
}

async function pushE2ESchema(db: SchemaDatabase): Promise<void> {
  // drizzle-kit is deliberately loaded only in global setup. It is large and
  // none of the Playwright workers need it after the schema has been prepared.
  const { pushSchema } = await import("drizzle-kit/api");

  await ensureDbExtensions(db);
  const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
    "public",
  ]);
  await apply();
}

async function seedHome(db: SchemaDatabase): Promise<void> {
  // The application requires exactly one real hierarchy root. Keep this in the
  // checked-out database rather than the IntegreSQL template so a cached older
  // template is repaired before a worker starts.
  await db.execute(sql`
    INSERT INTO "Location" (shortcode, name, aliases, tags, type, "parentId")
    VALUES ('LOC-HM3E', 'Home', ARRAY[]::text[], ARRAY[]::text[], 'house', NULL)
  `);
}

function remapIntegreSQLConfig(
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig {
  const { host, port } = testServiceConfig();
  return { ...databaseConfig, host, port };
}

async function templateContext() {
  const integreSQL = new IntegreSQLClient({
    url: testServiceConfig().url,
  });
  const hash = await integreSQL.hashFiles([
    ...schemaTemplateInputs,
    // Browser acceptance and Vitest run concurrently in `test:all`. A distinct
    // template prevents either process's template initialization/reset cycle
    // from invalidating the other's checked-out databases mid-run.
    "./tests/e2e/e2e-database.ts",
  ]);

  return { hash, integreSQL };
}

/** Prepare the one schema template all browser workers clone. */
export async function prepareE2EDatabaseTemplate(): Promise<void> {
  const { hash, integreSQL } = await templateContext();

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
}

/** Check out one isolated database after global setup has finalized the template. */
export async function createE2EDatabase(): Promise<E2EDatabase> {
  const { hash, integreSQL } = await templateContext();
  console.log("[E2E Worker] Getting fresh database from IntegreSQL...");

  const databaseConfig = await integreSQL.getTestDatabase(hash);
  const databaseUrl = integreSQL.databaseConfigToConnectionUrl(
    remapIntegreSQLConfig(databaseConfig),
  );
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    const seedDb = drizzleNodePostgres(seedPool);
    await seedHome(seedDb);
    await seedDb.insert(schema.productCategory).values(taxonomyRootFixtures);
  } finally {
    await seedPool.end();
  }

  console.log(
    `[E2E Worker] Using PostgreSQL database: ${databaseConfig.database}`,
  );
  const testId = Number(/_(\d+)$/u.exec(databaseConfig.database)?.[1]);
  if (!Number.isInteger(testId)) {
    throw new Error(
      `Could not parse IntegreSQL pool id from ${databaseConfig.database}`,
    );
  }
  let closed = false;
  return {
    databaseUrl,
    name: databaseConfig.database,
    async close() {
      if (closed) return;
      closed = true;
      await integreSQL.api.recreateTestDatabase(hash, testId);
    },
  };
}
