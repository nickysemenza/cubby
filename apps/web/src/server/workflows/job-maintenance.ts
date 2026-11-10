import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import { repairImageProcessingExecution } from "~/server/domains/image-processing/repo/image-processing";
import { pruneFinishedJobs } from "~/server/generic/jobs/repo/job-retention";

const log = createLogger("job-maintenance");

/** Hourly bounded repair and retention. Unfinished rows remain for the next tick. */
export async function maintainJobs(db: Database) {
  const repair = await repairImageProcessingExecution(db, 500);
  const pruned = await pruneFinishedJobs(db, { limit: 2_000, now: new Date() });
  log.info("job maintenance", { repair, pruned });
  return { repair, pruned };
}
