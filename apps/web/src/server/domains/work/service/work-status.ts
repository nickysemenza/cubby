import type { WorkStatus, WorkStuckItem } from "@cubby/schemas/work-status";
import { countLabel } from "@cubby/shared/pluralize";

import type { Database } from "~/server/db";
import { readDeviceBacklog } from "~/server/domains/image-processing/repo/device-backlog";
import { readStoppedRuns } from "~/server/generic/jobs/repo/job-queue";
import {
  readBackgroundWorkStatus,
  STUCK_WINDOW_MINUTES,
  type DrainDue,
} from "~/server/generic/jobs/repo/observation";

/** The one server rule for what is stuck: the sidebar and the Work page share it. */
export async function readWorkStatus(
  db: Database,
  now = new Date(),
  drains: readonly DrainDue[] = [],
): Promise<WorkStatus> {
  const [background, device, runs] = await Promise.all([
    readBackgroundWorkStatus(db, now, drains),
    readDeviceBacklog(db, now),
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
    lastFinishedAt: background.lastFinishedAt?.toISOString() ?? null,
    behind: background.behind,
    stuck: [...deviceStuck, ...background.stuck, ...runs],
  };
}
