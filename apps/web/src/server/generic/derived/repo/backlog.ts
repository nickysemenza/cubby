import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

const countRow = z.object({
  target: z.string(),
  count: z.coerce.number().int().nonnegative(),
});

/** Fanout tickets count as outstanding work for the derived kind they will refresh. */
/** Published values are reported per minute over this window. */
const RECENT_MINUTES = 15;

export async function readDerivedBacklog(
  db: Database,
): Promise<DerivedBacklog> {
  const result = await repositoryQueries(db).execute(
    sql`SELECT split_part(target, '@', 1) AS target, count(*)::int AS count FROM "DerivedDirty" GROUP BY split_part(target, '@', 1) ORDER BY 1`,
  );
  const rows = z.array(countRow).parse(result.rows);
  const [oldest, published] = await Promise.all([
    repositoryQueries(db).execute(
      sql`SELECT extract(epoch FROM now() - min("dirtiedAt"))::int AS seconds FROM "DerivedDirty"`,
    ),
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
    oldestWaitingSeconds: z
      .object({ seconds: z.number().int().nullable() })
      .parse(oldest.rows[0] ?? { seconds: null }).seconds,
    recent: { windowMinutes: RECENT_MINUTES, perMinute },
    total: rows.reduce((sum, row) => sum + row.count, 0),
    kinds: storedDerivedDeclarations().map((declaration) => ({
      entity: declaration.entity,
      field: declaration.key,
      count: rows.find((row) => row.target === declaration.target)?.count ?? 0,
    })),
  };
}
