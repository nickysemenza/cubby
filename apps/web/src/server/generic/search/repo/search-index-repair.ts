import type { Database } from "~/server/db/database";
import { requestDerivedRebuild } from "~/server/generic/derived/repo/rebuild";
import { readSnapshotState as readDerivedRebuildStatus } from "~/server/generic/derived/repo/snapshot-state";

/** Explicit search repair joins the same coarse Worker pass. */
export async function scheduleSearchRepair(db: Database): Promise<void> {
  await requestDerivedRebuild(db);
}
export async function readSearchRepairProgress(db: Database) {
  const pass = await readDerivedRebuildStatus(db);
  return pass;
}
