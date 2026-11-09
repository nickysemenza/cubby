import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./gateway-egress-migrations/20261023161138_legacy_baseline/migration.sql?raw";

export async function initializeGatewayEgress(storage: DurableObjectStorage) {
  await migrate(drizzle(storage, { paramsInErrors: true }), {
    migrations: { "20261023161138_legacy_baseline": baseline },
  });
}
