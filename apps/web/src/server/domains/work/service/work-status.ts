import type { ActorContext } from "@cubby/schemas/context";
import type { WorkStatus } from "@cubby/schemas/work-status";

import type { Database } from "~/server/db";
import { readKernelDiagnostics } from "~/server/domains/work/repo/kernel-diagnostics";
export async function readWorkStatus(
  db: Database,
  now: Date,
  viewer: ActorContext,
): Promise<WorkStatus> {
  const work = await readKernelDiagnostics(db, viewer);
  const oldest = work.groups.flatMap((group) =>
    group.oldestWaiting ? [new Date(group.oldestWaiting).getTime()] : [],
  );
  return {
    readAt: now.toISOString(),
    lastFinishedAt: work.lastFinishedAt,
    stuckCount: work.groups.reduce((sum, group) => sum + group.stuck, 0),
    behind: oldest.some((at) => now.getTime() - at > 5 * 60_000),
    stuck: work.failures.map((failure) => ({
      key:
        failure.target.type === "ask"
          ? failure.target.id
          : `${failure.target.kind}:${failure.target.key}`,
      title: failure.label,
      record: failure.record,
      body: `${failure.label} stopped. Open Technical details for the diagnostic.`,
      since: failure.at,
      diagnostic: failure.error,
      action: { type: "none" as const },
    })),
  };
}
