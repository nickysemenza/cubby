import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import { repairImageProcessingExecution } from "~/server/domains/image-processing/repo/image-processing";
import { pruneFinishedJobs } from "~/server/generic/jobs/repo/job-retention";
import { expireUnreviewedSuggestions } from "~/server/generic/suggestions/repo/suggestion-state";

const log = createLogger("job-maintenance");

/** Hourly bounded repair, retention and expiry of unreviewed field Suggestions. Unfinished rows remain for the next tick. */
export async function maintainJobs(db: Database) {
  const repair = await repairImageProcessingExecution(db, 500);
  const pruned = await pruneFinishedJobs(db, { limit: 2_000, now: new Date() });
  const expired = await expireUnreviewedSuggestions(db, { limit: 5_000 });
  log.info("job maintenance", { repair, pruned, expired });
  return { repair, pruned, expired };
}
