import type { RunId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";

/** The statuses `Run_one_active_maintenance` allows only one pass to hold. */
export const ACTIVE_MAINTENANCE_STATUSES = ["running", "paused_auth"] as const;

/** The newest maintenance pass, or the active one when `activeOnly`. */
export async function latestMaintenanceRun(db: Database, activeOnly: boolean) {
  const [row] = await getDb(db)
    .select()
    .from(run)
    .where(
      and(
        eq(run.purpose, "maintenance"),
        isNull(run.deletedAt),
        activeOnly
          ? inArray(run.status, [...ACTIVE_MAINTENANCE_STATUSES])
          : undefined,
      ),
    )
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(1);
  return row ?? null;
}

export async function readRunShortcode(db: Database, runId: RunId) {
  const [row] = await getDb(db)
    .select({ shortcode: run.shortcode })
    .from(run)
    .where(eq(run.id, runId));
  return row?.shortcode ?? null;
}
