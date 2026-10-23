import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./database-freshness-migrations/0000_baseline.sql?raw";
import journal from "./database-freshness-migrations/meta/_journal.json";
import { freshness } from "./database-freshness-sql-schema";

export class DatabaseFreshnessStore {
  private readonly db;

  constructor(private readonly storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  async migrate() {
    const entry = journal.entries[0];
    if (!entry)
      throw new Error("Missing database freshness baseline journal entry");
    // Catalog SQL is needed only for adopting the pre-Drizzle schema. Once a
    // baseline is recorded, future migrations own compatibility on restart.
    const ledger = this.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'",
      )
      .toArray();
    const adopted =
      ledger.length > 0 &&
      this.storage.sql
        .exec(
          "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
          entry.when,
        )
        .toArray().length > 0;
    if (!adopted) {
      const existing = this.storage.sql
        .exec("SELECT sql FROM sqlite_master WHERE name = 'freshness'")
        .toArray()[0];
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/if\s+not\s+exists/gu, "")
          .replace(/[\s;`"[\]]/gu, "");
      // Older deployed constructors added these columns. Retiring their callers
      // did not remove persisted columns, so accept and preserve those shapes.
      const withoutRetiredColumns = (value: string) =>
        normalize(value)
          .replace(",write_sequenceintegernotnulldefault0", "")
          .replace(",refresh_due_atreal", "");
      if (
        existing &&
        (typeof existing.sql !== "string" ||
          withoutRetiredColumns(existing.sql) !== normalize(baseline))
      )
        throw new Error("Incompatible legacy database freshness schema");
    }
    await migrate(this.db, { journal, migrations: { m0000: baseline } });
    this.db
      .insert(freshness)
      .values({ id: 1, lastWriteAt: Date.now() })
      .onConflictDoNothing()
      .run();
    // Problem counts are read directly. Retire the old snapshot without
    // touching freshness or its journal.
    this.storage.sql.exec("DROP TABLE IF EXISTS problem_counts");
  }

  read() {
    const row = this.db
      .select()
      .from(freshness)
      .where(eq(freshness.id, 1))
      .get();
    if (!row)
      throw new Error("Database freshness storage has not been initialized");
    return row.lastWriteAt;
  }

  recordWrite() {
    this.db
      .update(freshness)
      .set({ lastWriteAt: sql`max(${freshness.lastWriteAt}, ${Date.now()})` })
      .where(eq(freshness.id, 1))
      .run();
    return this.read();
  }
}
