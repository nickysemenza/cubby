import {
  cloudImageDue,
  cloudImageNext,
  dueCloudImageJobs,
} from "~/server/domains/image-processing/repo/image-processing";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { wakeAt } from "~/server/workflows/background-tasks/publish";

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
  async page(db) {
    const due = await dueCloudImageJobs(db, PAGE_ROWS);
    if (!due.length) return { claimed: 0 };
    // A killed invocation's row leases lapse unobserved; this wake recovers them.
    await wakeAt(new Date(Date.now() + CLOUD_IMAGE_LEASE_MS + 5_000), {
      source: "image-cloud-lease",
    });
    let claimed = 0;
    const lane = async () => {
      for (let id = due.shift(); id; id = due.shift())
        if ((await dispatchImageProcessingWakeup(db, id)) !== "skipped")
          claimed++;
    };
    const settled = await Promise.allSettled(
      Array.from({ length: PAGE_CONCURRENCY }, lane),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return { claimed };
  },
};
