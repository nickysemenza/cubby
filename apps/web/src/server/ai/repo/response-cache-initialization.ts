import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./response-cache-migrations/20261023161136_legacy_baseline/migration.sql?raw";

export async function initializeResponseCache(storage: DurableObjectStorage) {
  await migrate(drizzle(storage, { paramsInErrors: true }), {
    migrations: { "20261023161136_legacy_baseline": baseline },
  });
}
