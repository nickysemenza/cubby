import "dotenv/config";

import { getErrorMessage } from "@cubby/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { Database, type DatabaseRuntime } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { backfillGardenLocationPeriods } from "../src/server/repo/garden";

const args = new Set(process.argv.slice(2));
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const target = option("--target");
const rolloutDate = option("--rollout-date");
const execute = args.has("--execute");
const isCalendarDay = (value: string | undefined) =>
  z.iso.date().safeParse(value).success;

if (!target || !isCalendarDay(rolloutDate)) {
  console.error(
    "Usage: pnpm db:backfill-garden-location-periods -- --target <name> --rollout-date YYYY-MM-DD [--execute]",
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required for the Garden location-period backfill.",
  );
  process.exit(1);
}
const parsedDatabaseUrl = new URL(databaseUrl);
const databaseTarget = `${parsedDatabaseUrl.hostname}${parsedDatabaseUrl.port ? `:${parsedDatabaseUrl.port}` : ""}${parsedDatabaseUrl.pathname}`;

const pool = new Pool({ connectionString: databaseUrl });
const client = drizzle({ client: pool, schema });
const runtime: DatabaseRuntime = {
  client,
  withConnection: async (fn) => fn(client),
};
const db = new Database(() => runtime);

try {
  const result = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.planting)
    .leftJoin(
      schema.plantingLocationPeriod,
      eq(schema.plantingLocationPeriod.plantingId, schema.planting.id),
    )
    .where(
      and(
        isNull(schema.planting.deletedAt),
        isNull(schema.plantingLocationPeriod.id),
      ),
    );
  const candidateCount = Number(result[0]?.count ?? 0);
  console.log(
    `${target} (${databaseTarget}): ${candidateCount} planting(s) have no location periods; rollout date ${rolloutDate}.`,
  );
  if (!execute) {
    console.log(
      "Dry run only. Re-run with --execute after verifying the target.",
    );
  } else {
    await backfillGardenLocationPeriods(db, { rolloutDate });
    console.log(
      `${target} (${databaseTarget}): Garden location-period backfill completed.`,
    );
  }
} catch (error) {
  console.error(
    `Garden location-period backfill could not run: ${getErrorMessage(error)}`,
  );
  console.error(
    "Apply the additive PlantingLocationPeriod schema before running this maintenance command.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
