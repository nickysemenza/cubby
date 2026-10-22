import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers/core";
import { notDeleted } from "~/server/db/helpers/predicates";
import { run } from "~/server/db/schema";

// Lifecycle is in the Worker entry closure; this module must not import AI policy/discovery.
const AI_REFRESH_SCHEDULING_LOCK = "cubby-ai-refresh-scheduling";
const MAX_ACTIVE_AI_REFRESH_RUNS = 2;

/** Nonblocking admission must not pin another origin connection in a lock wait. */
export async function tryLockAiRefreshScheduling(db: Database) {
  const rows = await getDb(db).execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${AI_REFRESH_SCHEDULING_LOCK})) AS locked`,
  );
  return rows.rows[0]?.locked === true;
}

/** Discovery has an activation owner; Sweeps own their evaluations and take no slot. */
export async function hasAiRefreshRunCapacity(db: Database, excludeId?: RunId) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(run)
    .where(
      and(
        eq(run.purpose, "ai_refresh"),
        inArray(run.status, ["running", "paused", "paused_auth"]),
        sql`coalesce((${run.input}->>${aiRefreshRunInput.keyof().enum.discovery})::boolean, false) = false`,
        excludeId ? ne(run.id, excludeId) : undefined,
        notDeleted(run),
      ),
    );
  return (row?.count ?? 0) < MAX_ACTIVE_AI_REFRESH_RUNS;
}
