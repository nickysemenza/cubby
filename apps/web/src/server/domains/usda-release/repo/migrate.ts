import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./migrations/20261023161411_baseline/migration.sql?raw";

export async function migrateUsdaRelease(storage: DurableObjectStorage) {
  await migrate(drizzle(storage, { paramsInErrors: true }), {
    migrations: { "20261023161411_baseline": baseline },
  });
}
