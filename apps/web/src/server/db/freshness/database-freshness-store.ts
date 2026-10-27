import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./database-freshness-migrations/0000_baseline.sql?raw";
import journal from "./database-freshness-migrations/meta/_journal.json";
import { freshness } from "./database-freshness-sql-schema";

export class DatabaseFreshnessStore {
  private readonly db;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  async migrate() {
    await migrate(this.db, { journal, migrations: { m0000: baseline } });
    this.db
      .insert(freshness)
      .values({ id: 1, lastWriteAt: Date.now() })
      .onConflictDoNothing()
      .run();
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
