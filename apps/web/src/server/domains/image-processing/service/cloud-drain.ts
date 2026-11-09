import type { ImageJobId } from "@cubby/schemas/identifiers";

import {
  cloudImageDue,
  cloudImageLeaseLapsed,
  cloudImageNext,
  dueCloudImageJobs,
} from "~/server/domains/image-processing/repo/image-processing";
import type { BackgroundDrain } from "~/server/generic/background/drains";

import {
  CLOUD_IMAGE_LEASE_MS,
  dispatchImageProcessingWakeup,
} from "./dispatch";

const PAGE_ROWS = 4;
/** Provider calls run outside transactions; two at once share the permit's two sockets. */
const PAGE_CONCURRENCY = 2;

/**
 * Cloud image work has no queue row: each open cloud `ImageProcessingJob` is its
 * own durable claim. Device rows are never reached here.
 */
export const cloudImageDrain: BackgroundDrain = {
  name: "image.cloud",
  due: () => cloudImageDue("image.cloud"),
  next: cloudImageNext,
  recovers: (db, ids) => cloudImageLeaseLapsed(db, ids),
  async page(db, _unit, armRecovery) {
    const due = await dueCloudImageJobs(db, PAGE_ROWS);
    if (!due.length) return { claimed: 0 };
    const ids: ImageJobId[] = [...due];
    // A killed invocation's row leases lapse unobserved; armed once, on the
    // first row this page actually claims.
    let armed: Promise<void> | undefined;
    const onClaimed = () =>
      (armed ??=
        armRecovery?.({
          ids,
          afterMs: CLOUD_IMAGE_LEASE_MS + 5_000,
          source: "image-cloud-lease",
        }) ?? Promise.resolve());
    const counts = { claimed: 0, published: 0, failed: 0, deferred: 0 };
    const lane = async () => {
      for (let id = due.shift(); id; id = due.shift()) {
        const outcome = await dispatchImageProcessingWakeup(db, id, {
          onClaimed,
        });
        if (outcome === "skipped") continue;
        counts.claimed++;
        if (outcome === "completed") counts.published++;
        else if (outcome === "failed") counts.failed++;
        else counts.deferred++;
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: PAGE_CONCURRENCY }, lane),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return {
      claimed: counts.claimed,
      published: counts.published,
      failed: counts.failed,
      ...(counts.claimed && counts.deferred === counts.claimed
        ? { outcome: "deferred" as const }
        : {}),
    };
  },
};
