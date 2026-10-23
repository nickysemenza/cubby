import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { assertLegacyReleaseSchema } from "@cubby/usda/release";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import baseline from "./migrations/0000_baseline.sql?raw";
import journal from "./migrations/meta/_journal.json";

export async function migrateUsdaRelease(storage: DurableObjectStorage) {
  const entry = journal.entries[0];
  if (!entry) throw new Error("Missing USDA release baseline journal entry");
  assertLegacyReleaseSchema(storage.sql, entry.when);
  await migrate(drizzle(storage), { journal, migrations: { m0000: baseline } });
}
