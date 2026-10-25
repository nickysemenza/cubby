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
export async function readDerivedBacklog(
  db: Database,
): Promise<DerivedBacklog> {
  const result = await repositoryQueries(db).execute(
    sql`SELECT split_part(target, '@', 1) AS target, count(*)::int AS count FROM "DerivedDirty" GROUP BY split_part(target, '@', 1) ORDER BY 1`,
  );
  const rows = z.array(countRow).parse(result.rows);
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    kinds: storedDerivedDeclarations().map((declaration) => ({
      entity: declaration.entity,
      field: declaration.key,
      count: rows.find((row) => row.target === declaration.target)?.count ?? 0,
    })),
  };
}
