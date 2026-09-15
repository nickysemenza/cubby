import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { databaseFreshness } from "./state";

/** One timestamp per database environment, shared by every household client. */
export class DatabaseFreshnessDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS freshness (id INTEGER PRIMARY KEY CHECK (id = 1), last_write_at REAL NOT NULL)",
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO freshness (id, last_write_at) VALUES (1, ?)",
      Date.now(),
    );
  }

  readFreshness() {
    const row = this.ctx.storage.sql
      .exec<{ last_write_at: number }>(
        "SELECT last_write_at FROM freshness WHERE id = 1",
      )
      .one();
    return databaseFreshness(row.last_write_at);
  }

  recordWrite() {
    this.ctx.storage.sql.exec(
      "UPDATE freshness SET last_write_at = MAX(last_write_at, ?) WHERE id = 1",
      Date.now(),
    );
    return this.readFreshness();
  }
}
