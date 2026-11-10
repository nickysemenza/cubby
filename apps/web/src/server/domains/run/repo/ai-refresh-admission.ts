import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers/core";

// Lifecycle is in the Worker entry closure; this module must not import AI policy/discovery.
const AI_REFRESH_SCHEDULING_LOCK = "cubby-ai-refresh-scheduling";

/** Nonblocking admission must not pin another origin connection in a lock wait. */
export async function tryLockAiRefreshScheduling(db: Database) {
  const rows = await getDb(db).execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${AI_REFRESH_SCHEDULING_LOCK})) AS locked`,
  );
  return rows.rows[0]?.locked === true;
}

/** A member's Stop must wait for a page already admitting, so nothing lands after it. */
export async function lockAiRefreshScheduling(db: Database) {
  await getDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${AI_REFRESH_SCHEDULING_LOCK}))`,
  );
}
