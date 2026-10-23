import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./response-cache-migrations/0000_legacy_baseline.sql?raw";
import journal from "./response-cache-migrations/meta/_journal.json";

export async function initializeResponseCache(storage: DurableObjectStorage) {
  await migrate(drizzle(storage), { journal, migrations: { m0000: baseline } });
}
