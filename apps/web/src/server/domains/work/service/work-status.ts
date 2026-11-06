import { NEEDS_YOU_FILTERS } from "@cubby/schemas/work-queue";
import type { WorkStatus, WorkStuckItem } from "@cubby/schemas/work-status";
import { getErrorMessage } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import { readDeviceBacklog } from "~/server/domains/image-processing/repo/device-backlog";
import { readStoppedRuns } from "~/server/generic/jobs/repo/job-queue";
import {
  readBackgroundWorkStatus,
  STUCK_WINDOW_MINUTES,
} from "~/server/generic/jobs/repo/observation";

import { readWorkQueue } from "./work-queue-read";

const log = createLogger("work-status");

type NeedsYouRead = Omit<Parameters<typeof readWorkQueue>[1], "input">;

/** A failed count must not read as "background work is unknown". The page's own queue shows the error. */
async function readNeedsYou(
  db: Database,
  read: NeedsYouRead,
): Promise<WorkStatus["needsYou"]> {
  try {
    const { meta } = await readWorkQueue(db, {
      ...read,
      input: { ...NEEDS_YOU_FILTERS, pageSize: 1 },
    });
    return {
      count: meta.totalCount,
      complete: !(
        meta.incompleteProjectIds?.length ||
        meta.incompleteDiagnosticSources?.length ||
        meta.incompleteSources?.length
      ),
    };
  } catch (error) {
    log.warn("needs-you count failed", { error: getErrorMessage(error) });
    return { count: 0, complete: false };
  }
}

/** The one server rule for what is stuck: the sidebar and the Work page share it. */
export async function readWorkStatus(
  db: Database,
  read: NeedsYouRead,
  now = new Date(),
): Promise<WorkStatus> {
  const [background, device, needsYou, runs] = await Promise.all([
    readBackgroundWorkStatus(db, now),
    readDeviceBacklog(db, now),
    readNeedsYou(db, read),
    readStoppedRuns(db, now),
  ]);
  const deviceWindow = new Date(now.getTime() - STUCK_WINDOW_MINUTES * 60_000);
  const deviceStuck: WorkStuckItem[] =
    device.waiting > 0 &&
    device.workingDevices === 0 &&
    background.deviceDueSince &&
    background.deviceDueSince <= deviceWindow
      ? [
          {
            key: "apple_device",
            title: "Photos are waiting for an Apple device",
            body: `${countLabel(device.waiting, "photo")} can't be processed until a device picks up the work. Open Cubby on your Mac, or run cubby companion.`,
            since: background.deviceDueSince.toISOString(),
            action: {
              type: "link",
              label: "View photos",
              href: "/image-jobs?state=waiting_for_device",
            },
            diagnostic: null,
          },
        ]
      : [];
  return {
    readAt: now.toISOString(),
    needsYou,
    lastFinishedAt: background.lastFinishedAt?.toISOString() ?? null,
    behind: background.behind,
    stuck: [...deviceStuck, ...background.stuck, ...runs],
  };
}
