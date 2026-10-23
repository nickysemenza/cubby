import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./gateway-egress-migrations/0000_legacy_baseline.sql?raw";
import journal from "./gateway-egress-migrations/meta/_journal.json";

export async function initializeGatewayEgress(storage: DurableObjectStorage) {
  await migrate(drizzle(storage), { journal, migrations: { m0000: baseline } });
}
