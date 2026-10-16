import { IntegreSQLClient } from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { migrateDatabase } from "./db-migrate";
import { hashSchemaTemplateInputs } from "./schema-template-inputs";
import { initializeRecoverableTemplate } from "./template-recovery";
import { testServiceConfig } from "./test-service-config";

export const templateClient = () =>
  new IntegreSQLClient({ url: testServiceConfig().url });

export function templateConnectionUrl(config: {
  username: string;
  password: string;
  database: string;
}): string {
  const { host, port } = testServiceConfig();
  return templateClient().databaseConfigToConnectionUrl({
    ...config,
    host,
    port,
  });
}

/** Identifiers are supplied by IntegreSQL or the guarded dev profile. */
export function databaseIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/u.test(name))
    throw new Error(`Invalid local database name: ${name}`);
  return `"${name}"`;
}

/** Every consumer starts from the same immutable, migration-keyed schema. */
export async function cloneSchemaTemplate(target: string): Promise<void> {
  if (!/^integresql_template_[0-9a-f]{40}$/u.test(target))
    throw new Error("Schema clones require an IntegreSQL template target");
  const client = templateClient();
  const hash = await initializeRecoverableTemplate(
    hashSchemaTemplateInputs(),
    async (config) => {
      const connection = new Client({
        connectionString: templateConnectionUrl(config),
      });
      await connection.connect();
      try {
        await migrateDatabase(drizzle(connection));
      } finally {
        await connection.end();
      }
    },
  );
  const lease = await client.api.getTestDatabase(hash);
  const adminUrl = new URL(templateConnectionUrl(lease.database.config));
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseIdentifier(target)}`);
    await admin.query(
      `CREATE DATABASE ${databaseIdentifier(target)} TEMPLATE ${databaseIdentifier(lease.database.config.database)}`,
    );
  } finally {
    await admin.end();
    await client.api.reuseTestDatabase(hash, lease.id);
  }
}
