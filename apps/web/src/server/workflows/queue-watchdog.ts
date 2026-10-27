import { createLogger } from "@cubby/worker-tracing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  queueHealthSnapshot,
  type QueueHealthSnapshot,
} from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import {
  countStrandedImageProcessing,
  repairImageProcessingExecution,
} from "~/server/domains/image-processing/repo/image-processing";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import {
  measureQueueHealth,
  pruneFinishedJobs,
  pruneOrphanJobIdentities,
  pruneObservedInvalidationCaptures,
} from "~/server/generic/jobs/repo/queue-health";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

const log = createLogger("queue-watchdog");

const WATCHDOG_KEY = "queue.watchdog";
const RETENTION_KEY = "jobs.retention";
/** The watchdog measures and repairs this often. */
export const QUEUE_WATCHDOG_INTERVAL_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;
const IMAGE_REPAIR_BATCH = 500;
const RETENTION_BATCH = 2_000;

/**
 * Keep the watchdog and retention Jobs enrolled. Each is one long-lived Job
 * that re-arms itself after every page, so its result always holds the
 * latest measurement; enrolling an existing one is a no-op.
 */
export async function enrollQueueMaintenance(db: Database) {
  for (const key of [WATCHDOG_KEY, RETENTION_KEY])
    await enqueueJob(db, { key, kind: key, input: {} });
}

/**
 * Repair stranded image execution, then measure per-kind queue health and
 * raise alerts with raw numbers. Tripped alerts are logged at error level
 * (Workers Logs alerting) and read by Activity through `job.health`.
 */
export const queueWatchdogHandler = defineJobHandler(
  z.object({}),
  async (db, claim) => {
    const repair = await repairImageProcessingExecution(db, IMAGE_REPAIR_BATCH);
    const previous = queueHealthSnapshot.safeParse(claim.result).data ?? null;
    const snapshot = await measureQueueHealth(db, {
      previous,
      imageDisagreement: await countStrandedImageProcessing(db),
    });
    const known = new Set(
      (previous?.alerts ?? []).map((alert) => `${alert.code}:${alert.kind}`),
    );
    const raised = snapshot.alerts.filter(
      (alert) => !known.has(`${alert.code}:${alert.kind}`),
    );
    if (raised.length) log.error("queue alerts raised", { alerts: raised });
    log.info("queue health", { repair, alerts: snapshot.alerts.length });
    return {
      page: {
        done: false,
        // A repair that hit its batch bound continues at once.
        availableAt: new Date(
          Date.now() + (repair.more ? 0 : QUEUE_WATCHDOG_INTERVAL_MS),
        ),
        result: snapshot,
      },
    };
  },
);

/**
 * Prune finished Job rows and observed invalidation capture times in bounded
 * batches; domain evidence stays.
 */
export const jobRetentionHandler = defineJobHandler(
  z.object({}),
  async (db) => {
    const pruned = await pruneFinishedJobs(db, { limit: RETENTION_BATCH });
    const captures = await pruneObservedInvalidationCaptures(db, {
      limit: RETENTION_BATCH,
    });
    const identities = await pruneOrphanJobIdentities(db, {
      limit: RETENTION_BATCH,
    });
    const more =
      pruned >= RETENTION_BATCH ||
      captures >= RETENTION_BATCH ||
      identities >= RETENTION_BATCH;
    return {
      page: {
        done: false,
        availableAt: new Date(Date.now() + (more ? 0 : RETENTION_INTERVAL_MS)),
        result: {
          pruned,
          captures,
          identities,
          prunedAt: new Date().toISOString(),
        },
      },
    };
  },
);

/** The latest watchdog measurement, or null before its first page. */
export async function readQueueHealth(
  db: Database,
): Promise<QueueHealthSnapshot | null> {
  const [row] = await getDb(db)
    .select({ result: job.result })
    .from(job)
    .where(eq(job.key, WATCHDOG_KEY));
  return queueHealthSnapshot.safeParse(row?.result).data ?? null;
}
