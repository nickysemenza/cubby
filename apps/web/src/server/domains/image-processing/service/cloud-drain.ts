import {
  dueCloudImageJobs,
  nextCloudImageDue,
} from "~/server/domains/image-processing/repo/image-processing";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { wakeAt } from "~/server/workflows/background-tasks/publish";

import {
  CLOUD_IMAGE_LEASE_MS,
  dispatchImageProcessingWakeup,
} from "./dispatch";

const PAGE_ROWS = 8;
/** Provider calls run outside transactions; two at once keep the round's sockets free. */
const PAGE_CONCURRENCY = 2;

/**
 * Cloud image work has no queue row: each open cloud `ImageProcessingJob` is its
 * own durable claim. Device rows are never reached here.
 */
export const cloudImageDrain: BackgroundDrain = {
  name: "image.cloud",
  async page(db, { deadline }) {
    let progressed = false;
    let due = await dueCloudImageJobs(db, PAGE_ROWS);
    if (due.length) {
      // A killed invocation leaves its leases behind; this wake covers them.
      await wakeAt(new Date(Date.now() + CLOUD_IMAGE_LEASE_MS + 5_000), {
        source: "image-cloud-lease",
      });
      while (due.length && Date.now() < deadline) {
        const page = due;
        let pageProgress = false;
        const lane = async () => {
          for (;;) {
            const id = page.shift();
            if (!id || Date.now() >= deadline) return;
            const outcome = await dispatchImageProcessingWakeup(db, id);
            pageProgress ||= outcome !== "skipped";
          }
        };
        await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, lane));
        progressed = pageProgress;
        // Rows a sibling consumer holds show no progress; never spin on them.
        due = pageProgress ? await dueCloudImageJobs(db, PAGE_ROWS) : [];
      }
    }
    return {
      more: progressed && due.length > 0,
      nextAt: await nextCloudImageDue(db),
    };
  },
};
