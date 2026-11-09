import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import {
  cloudImageDue,
  cloudImageNext,
  dueCloudImageJobs,
} from "~/server/domains/image-processing/repo/image-processing";
import type {
  ArmDrainRecovery,
  BackgroundDrain,
} from "~/server/generic/background/drains";
import { countDrainItems } from "~/server/generic/jobs/context";

import { dispatchImageProcessingWakeup } from "./dispatch";

const PAGE_ROWS = 4;
/** Provider calls run outside transactions; two at once share the permit's two sockets. */
const PAGE_CONCURRENCY = 2;

/**
 * Run these rows, each claimed as it is reached. A killed invocation's leases
 * lapse unobserved, so every claim arms its own recovery at its own lease
 * expiry, naming its attempt; rows a sibling took arm nothing.
 */
async function runRows(
  db: Database,
  rows: { id: ImageJobId; attemptId?: string }[],
  armRecovery: ArmDrainRecovery | undefined,
) {
  let claimed = 0;
  let deferred = 0;
  const lane = async () => {
    for (let row = rows.shift(); row; row = rows.shift()) {
      const outcome = await dispatchImageProcessingWakeup(db, row.id, {
        ...(row.attemptId && { attemptId: row.attemptId }),
        onClaimed: async (claim) => {
          countDrainItems({ claimed: 1 });
          await armRecovery?.({
            id: claim.id,
            attempt: claim.attemptId,
            leaseExpiresAt: claim.leaseExpiresAt,
            source: "image-cloud-lease",
          });
        },
      });
      if (outcome === "skipped") continue;
      claimed++;
      if (outcome === "completed") countDrainItems({ published: 1 });
      else if (outcome === "failed") countDrainItems({ failed: 1 });
      else deferred++;
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: PAGE_CONCURRENCY }, lane),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return {
    claimed,
    ...(claimed && deferred === claimed
      ? { outcome: "deferred" as const }
      : {}),
  };
}

/**
 * Cloud image work has no queue row: each open cloud `ImageProcessingJob` is its
 * own durable claim. Device rows are never reached here.
 */
export const cloudImageDrain: BackgroundDrain = {
  name: "image.cloud",
  due: () => cloudImageDue("image.cloud"),
  next: cloudImageNext,
  async page(db, _unit, armRecovery) {
    const due = await dueCloudImageJobs(db, PAGE_ROWS);
    if (!due.length) return { claimed: 0 };
    return runRows(
      db,
      due.map((id) => ({ id })),
      armRecovery,
    );
  },
  recover: (db, claim, armRecovery) =>
    runRows(
      db,
      [{ id: parseEntityId("imageJob", claim.id), attemptId: claim.attempt }],
      armRecovery,
    ),
};
