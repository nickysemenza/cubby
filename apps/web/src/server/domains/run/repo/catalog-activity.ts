import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run } from "~/server/db/schema";

/** Household-wide history, including routine and ephemeral work hidden by the list defaults. */
export async function readRunCatalogActivity(db: Database) {
  const fields = {
    purpose: run.purpose,
    shortcode: run.shortcode,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
  const latest = await getDb(db)
    .selectDistinctOn([run.purpose], fields)
    .from(run)
    .where(notDeleted(run))
    .orderBy(run.purpose, desc(run.startedAt), desc(run.shortcode));
  const completed = await getDb(db)
    .selectDistinctOn([run.purpose], fields)
    .from(run)
    .where(and(notDeleted(run), eq(run.status, "completed")))
    .orderBy(
      run.purpose,
      sql`${run.endedAt} DESC NULLS LAST`,
      desc(run.startedAt),
      desc(run.shortcode),
    );
  const serialize = (row: (typeof latest)[number]) => ({
    ...row,
    purpose: runPurpose.parse(row.purpose),
    status: runStatus.parse(row.status),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  });
  return { latest: latest.map(serialize), completed: completed.map(serialize) };
}
