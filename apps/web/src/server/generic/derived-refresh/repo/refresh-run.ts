import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { nextPendingEmbeddingWake } from "~/server/generic/embedding/repo/embedding-artifact";

import { nextConnectionRetirementWake } from "./connection-retirement";
import { nextDerivedRefreshWork, nextDerivedRefreshWake } from "./process";
import { reconcileAvailability } from "./reconcile";
import { nextStatementRetirementWake } from "./statement-retirement";

export async function nextRefreshWake(db: Database) {
  const dates = (
    await Promise.all([
      nextDerivedRefreshWake(db),
      nextPendingEmbeddingWake(db),
      nextStatementRetirementWake(db),
      nextConnectionRetirementWake(db),
    ])
  )
    .filter((date) => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return dates[0] ?? null;
}

export async function ensureDerivedRefreshRun(db: Database) {
  const active = async () => {
    const [row] = await getDb(db)
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.purpose, "derived_refresh"),
          inArray(run.status, ["running", "paused_auth", "paused"]),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  };
  const existing = await active();
  if (existing) return { id: existing, created: false };
  const work = await nextDerivedRefreshWork(db);
  const repair = await reconcileAvailability(db);
  const retryAt = work ? null : await nextRefreshWake(db);
  if (!work && !retryAt && !repair.due) return null;
  try {
    const id = await ensureRun(db, systemActor(), {
      purpose: "derived_refresh",
      trigger: "scheduled",
      status: "running",
      clientKey: `derived-refresh:${work ? `${work.id}:${work.version}:${work.attempts}` : retryAt ? `retry:${retryAt.toISOString()}` : `reconcile:${repair.key}`}`,
    });
    return { id, created: true };
  } catch (error) {
    if (!isUniqueViolation(error, "Run_one_active_derived_refresh"))
      throw error;
    const id = await active();
    if (!id) throw error;
    return { id, created: false };
  }
}
