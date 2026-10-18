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

/**
 * Ends a pass that is still waiting out an AI budget window so the next
 * nightly pass can start; its free backlogs would otherwise wait behind paid
 * image work for as long as that backlog lasts.
 */
export async function endBudgetPausedPass(db: Database, runId: RunId) {
  const [ended] = await getDb(db)
    .update(run)
    .set({
      status: "needs_review",
      endedAt: new Date(),
      failureCode: "superseded_by_next_pass",
      dispatchError:
        "Ended while paused for the AI budget; the next nightly pass continues every backlog.",
    })
    .where(
      and(
        eq(run.id, runId),
        eq(run.status, "paused_auth"),
        eq(run.failureCode, "execution_limit"),
      ),
    )
    .returning({ id: run.id });
  return Boolean(ended);
}
