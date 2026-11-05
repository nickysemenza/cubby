import type { Database } from "~/server/db/database";
import { runAfterCommit } from "~/server/db/helpers";
import { readDerivedRebuildStatus } from "~/server/generic/derived/repo/rebuild";
import { requestDerivedRebuild } from "~/server/generic/derived/repo/rebuild";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/** Explicit search repair joins the same coarse Worker pass. */
export async function scheduleSearchRepair(db: Database): Promise<void> {
  await requestDerivedRebuild(db);
  await runAfterCommit(db, () =>
    wakeJobs({ source: "search.explicit-repair" }),
  );
}
export async function readSearchRepairProgress(
  db: Database,
): Promise<{ pending: boolean; error: string | null }> {
  const pass = await readDerivedRebuildStatus(db);
  return { pending: pass.running, error: pass.error };
}
