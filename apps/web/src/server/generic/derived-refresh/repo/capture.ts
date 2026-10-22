import type { DerivedRefreshCapture } from "@cubby/schemas/derived-refresh";

import {
  repositoryBeforeCommit,
  repositoryAfterCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { scheduleRefreshFamilies } from "~/server/generic/derived-refresh/repo/families";

/** Register durable intent before the authoritative transaction commits. */
export async function captureDerivedRefresh(
  db: RepositoryQueryInput,
  captures: readonly DerivedRefreshCapture[],
  options: { invalidate?: boolean; force?: boolean } = {},
): Promise<void> {
  // Context writes may have no surviving endpoint; they still need the broad pass.
  if (!captures.some((ref) => ref.entityKind !== "run") && !options.force)
    return;
  await repositoryBeforeCommit(db, async (tx) => {
    await scheduleRefreshFamilies(tx, {
      invalidate: options.invalidate !== false,
    });
    await repositoryAfterCommit(tx, async () => {
      const { wakeJobs } =
        await import("~/server/workflows/background-tasks/publish");
      await wakeJobs({ source: "derived-refresh.capture" });
    });
  });
}
