import type { WorkStatus } from "@cubby/schemas/work-status";

import type { Database } from "~/server/db";
import { needsYou } from "~/server/kernel/api";
export async function readWorkStatus(
  db: Database,
  now: Date,
): Promise<WorkStatus> {
  const work = await needsYou(db, { limit: 100 });
  return {
    readAt: now.toISOString(),
    lastFinishedAt: null,
    behind: false,
    stuck: work.items
      .filter((item) => item.stage === "stuck")
      .map((item) => ({
        key: item.shortcode,
        title: item.shortcode,
        body: item.firstGap,
        since: item.since ?? now.toISOString(),
        diagnostic: item.firstGap,
        action: {
          type: "link" as const,
          label: "Open record",
          href: `/${item.shortcode}`,
        },
      })),
  };
}
