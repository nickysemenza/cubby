import { is, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { ensureDbExtensions } from "./db-extensions";
import { installEntityIdentityTriggers } from "../src/server/db/entity-identity-schema";
import { assertDevDatabaseUrl } from "./dev-db-guard";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";

/**
 * drizzle-kit push matches CHECK constraints by name, so an edited expression
 * (a new enum value in `Run_purpose_check`, say) never reaches a
 * long-lived dev database and valid writes fail there. Re-create every
 * declared check; fresh test databases and production migrations don't need
 * this.
 */
async function reconcileCheckConstraints(
  db: NodePgDatabase,
  schema: typeof import("../src/server/db/schema"),
): Promise<number> {
  const dialect = new PgDialect();
  let count = 0;
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const { name, schema: tableSchema, checks } = getTableConfig(table);
    const qualified = tableSchema ? `"${tableSchema}"."${name}"` : `"${name}"`;
    for (const check of checks) {
      // "indexes" renders column references unqualified, as a CHECK requires.
      const { sql: expression, params } = dialect.sqlToQuery(
        check.value,
        "indexes",
      );
      if (params.length > 0)
        throw new Error(`${check.name} has bound parameters; inline them`);
      await db.execute(
        sql.raw(
          `ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS "${check.name}", ADD CONSTRAINT "${check.name}" CHECK (${expression})`,
        ),
      );
      count += 1;
    }
  }
  return count;
}

/** Push the application schema to the local dev database (drizzle-kit push, same as `db:push`). */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assertDevDatabaseUrl(databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    console.log("[dev-db] Pushing schema...");
    const schema = await import("../src/server/db/schema");
    await ensureDbExtensions(db);
    const { pushSchema } = await import("drizzle-kit/api");
    const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
      "public",
    ]);
    await apply();
    const checks = await reconcileCheckConstraints(db, schema);
    // drizzle-kit push does not manage triggers (ADR 0006).
    await installEntityIdentityTriggers(db);
    console.log(`[dev-db] Schema pushed; ${checks} check constraints current`);
  } finally {
    await pool.end();
  }
}

await main();
