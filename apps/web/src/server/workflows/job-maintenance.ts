import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import { repairImageProcessingExecution } from "~/server/domains/image-processing/repo/image-processing";


const log = createLogger("job-maintenance");

/** Hourly bounded repair and retention. Unfinished rows remain for the next tick. */
export async function maintainJobs(db: Database) {
  const repair = await repairImageProcessingExecution(db, 500);
  const { startPass } = await import("~/server/kernel/api");
  const { retentionPass } = await import("./retention-pass");
  await startPass(db, retentionPass);
  log.info("job maintenance", { repair });
  return { repair };
}
