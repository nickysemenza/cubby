import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./migrations/0000_baseline.sql?raw";
import journal from "./migrations/meta/_journal.json";

export async function migrateUsdaRelease(storage: DurableObjectStorage) {
  await migrate(drizzle(storage), { journal, migrations: { m0000: baseline } });
}
