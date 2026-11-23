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

/** Offer a future deadline this writer set, after its transaction commits. */
export async function wakeAtDeadline(
  db: Database,
  at: Date,
  source: string,
): Promise<void> {
  const { wakeAt } =
    await import("~/server/workflows/background-tasks/publish");
  await wakeAt(at, { source, db });
}

/**
 * A stale holder's recovery does not depend on its Worker reaching the end of
 * a page. Inside a delivery the unacknowledged permit is redelivered after a
 * crash, and the delivery's own offer includes every live claim deadline.
 */
export async function wakeClaimRecovery(
  deadline: Date,
  db?: Database,
): Promise<void> {
  const { wakeAt, withinDelivery } =
    await import("~/server/workflows/background-tasks/publish");
  if (withinDelivery()) return;
  await wakeAt(deadline, { source: "kernel.claim-recovery", db });
}
