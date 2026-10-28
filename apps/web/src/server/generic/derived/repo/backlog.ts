import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { drainBacklog } from "~/server/generic/jobs/repo/work-items";

/** Published values are reported per minute over this window. */
const RECENT_MINUTES = 15;

export async function readDerivedBacklog(
  db: Database,
): Promise<DerivedBacklog> {
  const [{ targets: rows, oldestSeconds }, published] = await Promise.all([
    // Fanout tickets (`target@column`) count toward the kind they refresh.
    drainBacklog(db, DERIVED_DRAIN_JOB_KEY),
    repositoryQueries(db).execute(
      sql`SELECT floor(extract(epoch FROM now() - "computedAt") / 60)::int AS age, count(*)::int AS count
        FROM "DerivedValue"
        WHERE "computedAt" > now() - ${RECENT_MINUTES} * interval '1 minute'
        GROUP BY 1`,
    ),
  ]);
  const perMinute = Array.from({ length: RECENT_MINUTES }, () => 0);
  for (const row of z
    .array(z.object({ age: z.number().int(), count: z.number().int() }))
    .parse(published.rows))
    if (row.age >= 0 && row.age < RECENT_MINUTES)
      perMinute[RECENT_MINUTES - 1 - row.age] = row.count;
  return {
    oldestWaitingSeconds: oldestSeconds,
    recent: { windowMinutes: RECENT_MINUTES, perMinute },
    total: rows.reduce((sum, row) => sum + row.count, 0),
    kinds: storedDerivedDeclarations().map((declaration) => ({
      entity: declaration.entity,
      field: declaration.key,
      count: rows.find((row) => row.target === declaration.target)?.count ?? 0,
    })),
  };
}
