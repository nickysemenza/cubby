import {
  dueCloudImageJobs,
  nextCloudImageDue,
} from "~/server/domains/image-processing/repo/image-processing";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { runBackgroundPage } from "~/server/generic/background/page-budget";
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
  async page(db, round) {
    const { deadline } = round;
    let progressed = false;
    let leaseRecovery: Promise<void> | undefined;
    let due = await dueCloudImageJobs(db, PAGE_ROWS);
    if (due.length) {
      while (due.length && Date.now() < deadline) {
        const page = due;
        let pageProgress = false;
        const lane = async () => {
          for (;;) {
            const id = page.shift();
            if (!id || Date.now() >= deadline) return;
            const admitted = await runBackgroundPage({
              admit: round.runPage,
              work: async () => {
                // Arm recovery after admission, before any payload or durable claim.
                leaseRecovery ??= wakeAt(
                  new Date(Date.now() + CLOUD_IMAGE_LEASE_MS + 5_000),
                  {
                    source: "image-cloud-lease",
                  },
                );
                await leaseRecovery;
                if (Date.now() >= deadline) return "skipped";
                return dispatchImageProcessingWakeup(db, id);
              },
            });
            if (admitted.kind === "held") return;
            pageProgress ||= admitted.value !== "skipped";
          }
        };
        const settled = await Promise.allSettled(
          Array.from({ length: PAGE_CONCURRENCY }, lane),
        );
        const failure = settled.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
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
