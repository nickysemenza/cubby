import type { ActorContext } from "@cubby/schemas/context";
import { createLogger } from "@cubby/worker-tracing";

import type { JobSetFilter } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { retryJobSet } from "../repo/job-queue";

const log = createLogger("jobs");

/**
 * Bulk Retry now on a filtered Job set. The retried Job ids and the member
 * who asked are recorded in the Worker log; each Job keeps its prior error.
 */
export async function retryJobSetNow(
  db: Database,
  actor: ActorContext,
  filter: JobSetFilter,
) {
  const runId = filter.runId
    ? await resolveOrThrow(db, "run", filter.runId)
    : null;
  const retried = await retryJobSet(db, filter, runId);
  log.info("retry now", {
    actorUserId: actor.userId,
    channel: actor.channel,
    filter,
    retried: retried.length,
    jobIds: retried.slice(0, 500),
  });
  if (retried.length) {
    const { wakeJobs } =
      await import("~/server/workflows/background-tasks/publish");
    await wakeJobs({ source: "retry-now" });
    const { ringImageProcessingCompanions } =
      await import("~/server/domains/image-processing/repo/image-processing-ring");
    await ringImageProcessingCompanions();
  }
  return { retried: retried.length };
}
