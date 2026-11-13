import type { Database } from "~/server/db/database";
import { runAfterCommit } from "~/server/db/helpers";
import { requestDerivedRebuild } from "~/server/generic/derived/repo/rebuild";
import { readSnapshotState as readDerivedRebuildStatus } from "~/server/generic/derived/repo/snapshot-state";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/** Explicit search repair joins the same coarse Worker pass. */
export async function scheduleSearchRepair(db: Database): Promise<void> {
  await requestDerivedRebuild(db);
  await runAfterCommit(db, () =>
    wakeJobs({ source: "search.explicit-repair" }),
  );
}
export async function readSearchRepairProgress(db: Database) {
  const pass = await readDerivedRebuildStatus(db);
  return pass;
}
