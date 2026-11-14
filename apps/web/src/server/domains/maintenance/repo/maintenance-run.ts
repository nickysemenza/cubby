import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { householdWrite } from "~/server/kernel/gate";

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
async function endBudgetPausedPass(db: Database, runId: RunId) {
  const kernel = await import("~/server/kernel/api");
  const write = {
    table: run,
    entity: "run",
    ids: [runId],
    columns: ["status", "endedAt", "failureCode"],
  };
  // Revisions before the Run row, the order a kernel apply takes.
  await kernel.lockWrites(db, write);
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
  if (ended) await kernel.emitWrites(db, write);
  return Boolean(ended);
}

/**
 * Admit a pass in one transaction, or find what stands in its way. A nightly admission
 * names its household date, which admits one pass: an advisory lock serializes that date's
 * check with its insert across overlapping invocations. `status` is null for a new pass.
 */
export async function admitMaintenancePass(
  db: Database,
  actor: ActorContext,
  admission: "manual" | { householdDate: string },
): Promise<{ id: RunId; status: string | null } | { active: true }> {
  const manual = admission === "manual";
  const clientKey = manual
    ? undefined
    : `maintenance:nightly:${admission.householdDate}`;
  // The gate before the admission lock: ensuring the Run takes it.
  return householdWrite(db, async (tx) => {
    if (clientKey) {
      await getDb(tx).execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${clientKey}, 0))`,
      );
      const [already] = await getDb(tx)
        .select({ id: run.id, status: run.status })
        .from(run)
        .where(eq(run.clientKey, clientKey));
      if (already) return already;
    }
    let active = await latestMaintenanceRun(tx, true);
    if (active && !manual && (await endBudgetPausedPass(tx, active.id)))
      active = await latestMaintenanceRun(tx, true);
    if (active) return { active: true };
    const id = await ensureRun(tx, actor, {
      purpose: "maintenance",
      trigger: manual ? "manual" : "scheduled",
      status: "running",
      ...(clientKey ? { clientKey } : {}),
      notes: manual ? "Maintenance run now" : "Nightly maintenance",
    });
    return { id, status: null };
  });
}
