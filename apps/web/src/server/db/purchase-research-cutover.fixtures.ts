import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { migrateDatabase, MIGRATIONS_FOLDER } from "tooling/db-migrate";
import { leaseDatabase } from "tooling/test-database-lease";
import { z } from "zod";

import { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

import * as schema from "./schema";

const record = z.record(z.string(), z.json());
export type SavedTable = { name: string; rows: z.infer<typeof record>[] };
export const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(
    JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    ),
  );
const mainLength =
  journal.entries.findIndex(
    (entry) => entry.tag === "0024_neon_cache_diagnostics",
  ) + 1;
if (
  mainLength !== 25 ||
  journal.entries[mainLength]?.tag !== "0025_purchase_research"
)
  throw new Error(
    "Cutover rehearsal must use the main prefix and canonical rewrite migration.",
  );

export async function saveTables(database: Database): Promise<SavedTable[]> {
  const db = getDb(database);
  const tables = (
    await db.execute<{ name: string }>(
      sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
  ).rows;
  const saved: SavedTable[] = [];
  for (const { name } of tables) {
    const rows = (
      await db.execute<{ data: z.infer<typeof record> }>(
        sql.raw(`SELECT to_jsonb(t) AS data FROM ${identifier(name)} t`),
      )
    ).rows.map((row) => record.parse(row.data));
    if (rows.length) saved.push({ name, rows });
  }
  return saved;
}

/** Rebuild only a leased local database, then run the actual deploy migrator. */
export async function openMainCutover(
  saved: SavedTable[],
  restore: (table: SavedTable) => SavedTable["rows"] = (table) => table.rows,
) {
  const { lease, prepared: client } = await leaseDatabase(
    "vitest",
    async (target) => {
      const connection = new Client({ connectionString: target.databaseUrl });
      await connection.connect();
      return connection;
    },
  );
  const close = async () => {
    try {
      await client.end();
    } finally {
      await lease.close();
    }
  };
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("DROP SCHEMA drizzle CASCADE");
    await client.query("CREATE SCHEMA public");
    const migrations = readMigrationFiles({
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    if (migrations.length !== mainLength + 1)
      throw new Error("Unexpected cutover migration journal.");
    await client.query("BEGIN");
    try {
      await client.query(
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
      );
      for (const migration of migrations.slice(0, mainLength)) {
        for (const statement of migration.sql) await client.query(statement);
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [migration.hash, migration.folderMillis],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const existing = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
        )
      ).rows.map((row) => row.name),
    );
    // Current service fixtures provide valid history; columns introduced in the
    // rewrite are omitted by jsonb_populate_record against the main row shape.
    await client.query("SET session_replication_role = replica");
    try {
      for (const table of saved) {
        if (!existing.has(table.name)) continue;
        for (const row of restore(table))
          await client.query(
            `INSERT INTO ${identifier(table.name)} SELECT * FROM jsonb_populate_record(NULL::${identifier(table.name)}, $1::jsonb)`,
            [JSON.stringify(row)],
          );
      }
    } finally {
      await client.query("SET session_replication_role = origin");
    }
    const before: SavedTable[] = [];
    for (const table of saved.filter((table) => existing.has(table.name)))
      before.push({
        name: table.name,
        rows: (
          await client.query<{ data: z.infer<typeof record> }>(
            `SELECT to_jsonb(t) AS data FROM ${identifier(table.name)} t`,
          )
        ).rows.map((row) => record.parse(row.data)),
      });
    const migrationDb = drizzle(client);
    await migrateDatabase(migrationDb);
    await migrateDatabase(migrationDb);
    const migrated = drizzle({ client, schema });
    const database = new Database(() => ({
      client: migrated,
      withConnection: (fn) => fn(migrated),
    }));
    return { client, database, before, close };
  } catch (error) {
    await close();
    throw error;
  }
}
