import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import {
  claimCatchUp,
  releaseCatchUpClaim,
} from "~/server/repo/catch-up-claim";

/**
 * The app-open request's catch-up: claim the window and queue both passes
 * (`catch-up.service.ts`), whose graphs stay off this request.
 */
export async function requestCatchUp(
  db: Database,
): Promise<{ status: "queued" | "recent" }> {
  const claimedAt = new Date();
  if (!(await claimCatchUp(db, claimedAt))) return { status: "recent" };
  try {
    await publishBackgroundTasks(
      db,
      [
        { kind: "maintenance.recover", requestedAt: claimedAt.toISOString() },
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: claimedAt.toISOString(),
        },
      ],
      { source: "maintenance.app-open" },
    );
  } catch (error) {
    await releaseCatchUpClaim(db, claimedAt);
    throw error;
  }
  return { status: "queued" };
}
