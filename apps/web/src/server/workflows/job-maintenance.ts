import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { Database } from "~/server/db";
import { repairImageProcessingExecution } from "~/server/domains/image-processing/repo/image-processing";
import {
  pruneFinishedJobs,
  pruneObservedInvalidationCaptures,
} from "~/server/generic/jobs/repo/job-retention";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

const log = createLogger("job-maintenance");

const MAINTENANCE_KEY = "jobs.maintenance";
export const JOB_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;
const RETENTION_BATCH = 2_000;
const IMAGE_REPAIR_BATCH = 500;

/** Enroll the one recurring Job for image recovery, device wake and retention. */
export async function enrollQueueMaintenance(db: Database) {
  await enqueueJob(db, {
    key: MAINTENANCE_KEY,
    kind: MAINTENANCE_KEY,
    input: {},
  });
}

const maintenanceResult = z.object({
  retainedAt: z.iso.datetime().nullable().optional(),
});

/** Keep image execution, device wakes and retained Job rows recoverable. */
export const jobMaintenanceHandler = defineJobHandler(
  z.object({}),
  async (db, claim) => {
    const now = new Date();
    const previous = maintenanceResult.safeParse(claim.result).data;
    const retainedAt = previous?.retainedAt ?? null;
    const retentionDue =
      retainedAt === null ||
      now.getTime() - Date.parse(retainedAt) >= RETENTION_INTERVAL_MS;
    const repair = await repairImageProcessingExecution(db, IMAGE_REPAIR_BATCH);
    let pruned = 0;
    let captures = 0;
    let nextRetainedAt = retainedAt;
    if (retentionDue) {
      pruned = await pruneFinishedJobs(db, { limit: RETENTION_BATCH, now });
      captures = await pruneObservedInvalidationCaptures(db, {
        limit: RETENTION_BATCH,
      });
      if (pruned < RETENTION_BATCH && captures < RETENTION_BATCH)
        nextRetainedAt = now.toISOString();
    }
    const more =
      repair.more || pruned >= RETENTION_BATCH || captures >= RETENTION_BATCH;
    log.info("job maintenance", { repair, pruned, captures });
    return {
      page: {
        done: false,
        availableAt: new Date(
          Date.now() + (more ? 0 : JOB_MAINTENANCE_INTERVAL_MS),
        ),
        result: { retainedAt: nextRetainedAt },
      },
    };
  },
);
