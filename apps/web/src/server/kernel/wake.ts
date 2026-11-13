import type { Database } from "~/server/db/database";
import { repositoryAfterCommit } from "~/server/db/repository-access.boundary";

/** Wake the background runner once the dirtying transaction commits. */
export async function wakeAfterCommit(db: Database): Promise<void> {
  await repositoryAfterCommit(db, async () => {
    const { wakeJobs } =
      await import("~/server/workflows/background-tasks/publish");
    await wakeJobs({ source: "kernel.dirty" });
  });
}
