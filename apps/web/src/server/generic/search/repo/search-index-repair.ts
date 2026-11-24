import type { Database } from "~/server/db/database";
import { requestDerivedRebuild } from "~/server/generic/derived/repo/rebuild";
import { readSnapshotState as readDerivedRebuildStatus } from "~/server/generic/derived/repo/snapshot-state";
import { wakeAfterCommit } from "~/server/kernel/wake";

/**
 * Explicit search repair joins the same coarse Worker pass. The repository
 * module cannot reach the queue, so the wake is sent here.
 */
export async function scheduleSearchRepair(db: Database): Promise<void> {
  await requestDerivedRebuild(db);
  await wakeAfterCommit(db);
}
export async function readSearchRepairProgress(db: Database) {
  const pass = await readDerivedRebuildStatus(db);
  return pass;
}
