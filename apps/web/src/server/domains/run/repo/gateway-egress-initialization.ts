import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./gateway-egress-migrations/0000_legacy_baseline.sql?raw";
import journal from "./gateway-egress-migrations/meta/_journal.json";

export async function initializeGatewayEgress(storage: DurableObjectStorage) {
  const baselineEntry = journal.entries[0];
  if (!baselineEntry)
    throw new Error("Missing Durable Object baseline migration");
  // Catalog SQL is needed before Drizzle can adopt a pre-journal object.
  const hasJournal =
    storage.sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .toArray().length > 0;
  const adopted =
    hasJournal &&
    storage.sql
      .exec(
        "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
        baselineEntry.when,
      )
      .toArray().length > 0;
  // Later migrations may legitimately change these shapes. Check only adoption.
  if (!adopted) {
    // The retired typesafe_starts table is unmanaged; leave existing rows intact.
    const tables = {
      starts: [
        ["bucket", "TEXT", 1, 0],
        ["started", "INTEGER", 1, 0],
      ],
      permits: [
        ["token", "TEXT", 0, 1],
        ["bucket", "TEXT", 1, 0],
        ["deadline", "INTEGER", 1, 0],
      ],
      cooldowns: [
        ["bucket", "TEXT", 0, 1],
        ["until_ms", "INTEGER", 1, 0],
      ],
      credit_refusals: [
        ["bucket", "TEXT", 0, 1],
        ["until_ms", "INTEGER", 1, 0],
        ["reason", "TEXT", 1, 0],
        ["probe_window", "INTEGER", 1, 0],
      ],
      credit_epochs: [
        ["bucket", "TEXT", 0, 1],
        ["epoch", "INTEGER", 1, 0],
      ],
    };
    for (const [table, expected] of Object.entries(tables)) {
      const columns = storage.sql
        .exec(`PRAGMA table_xinfo('${table}')`)
        .toArray();
      if (!columns.length) continue;
      if (
        columns.length !== expected.length ||
        expected.some(([name, type, notNull, pk], index) => {
          const column = columns[index];
          return (
            !column ||
            column.name !== name ||
            column.type !== type ||
            column.pk !== pk ||
            // Legacy TEXT PRIMARY KEY has notnull=0; Drizzle makes it explicit.
            (column.notnull !== notNull &&
              !(pk === 1 && notNull === 0 && column.notnull === 1)) ||
            column.dflt_value !== null
          );
        })
      )
        throw new Error(
          `Incompatible AI Gateway egress legacy table: ${table}`,
        );
    }
    const index = storage.sql
      .exec(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'starts_time'",
      )
      .toArray()[0];
    if (index) {
      const columns = storage.sql
        .exec("PRAGMA index_info('starts_time')")
        .toArray();
      const details = storage.sql
        .exec("PRAGMA index_list('starts')")
        .toArray()
        .find((row) => row.name === "starts_time");
      if (
        index.tbl_name !== "starts" ||
        columns.length !== 1 ||
        columns[0]?.name !== "started" ||
        details?.unique !== 0 ||
        details.partial !== 0
      )
        throw new Error(
          "Incompatible AI Gateway egress legacy index: starts_time",
        );
    }
  }
  await migrate(drizzle(storage), { journal, migrations: { m0000: baseline } });
}
