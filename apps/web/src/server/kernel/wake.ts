import type { Database } from "~/server/db/database";
import { repositoryAfterCommit } from "~/server/db/repository-access.boundary";

/** Wake the background runner once the dirtying transaction commits. */
export async function wakeAfterCommit(db: Database): Promise<void> {
  await repositoryAfterCommit(
    db,
    async () => {
      const { wakeKernel } =
        await import("~/server/workflows/background-tasks/publish");
      await wakeKernel({ source: "kernel.dirty" });
    },
    "kernel.wake",
  );
}

/** A stale holder's recovery does not depend on its Worker reaching the end of a page. */
export async function wakeClaimRecovery(deadline: Date): Promise<void> {
  const { wakeAt } =
    await import("~/server/workflows/background-tasks/publish");
  await wakeAt(deadline, { source: "kernel.claim-recovery" });
}
