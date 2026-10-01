import { testServiceConfig } from "../../tooling/test-service-config";
import {
  hashSchemaTemplateInputs,
  schemaTemplateInputs,
} from "../../tooling/schema-template-inputs";
import { seedBaseWorld } from "../../tooling/factories/base-world";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrateDatabase } from "../../tooling/db-migrate";

export interface E2EDatabase {
  databaseUrl: string;
  name: string;
  close(): Promise<void>;
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
  const hash = hashSchemaTemplateInputs([
    ...schemaTemplateInputs,
    // Browser acceptance and Vitest can share one IntegreSQL service (a warm
    // local service, or two terminals). A distinct template prevents either
    // process's template initialization/reset cycle from invalidating the
    // other's checked-out databases mid-run.
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
      console.log("[E2E Setup] Migrating PostgreSQL template...");
      await migrateDatabase(drizzleNodePostgres(pool));
      console.log("[E2E Setup] PostgreSQL template migrated");
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
    // Seeded in the checked-out database rather than the IntegreSQL template so
    // a cached older template is repaired before a worker starts.
    await seedBaseWorld(drizzleNodePostgres(seedPool));
    // Every worker must start without corpus products, regardless of shard.
    const { rows } = await seedPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "Product"',
    );
    if (rows[0]?.count !== "0") {
      throw new Error("E2E database checkout contains corpus products");
    }
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
