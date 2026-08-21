import type {
  BackgroundBatchRef,
  BackgroundBatchSource,
  BackgroundJobKind,
} from "@cubby/schemas/background-jobs";
import { getBackgroundQueue, getProblemCountsCache } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  addBackgroundJobsToBatch,
  type CreateBackgroundJobInput,
  createBackgroundBatchWithJobs,
  getBackgroundBatchDetail,
  setBackgroundBatchProcessor,
  toBackgroundBatchRef,
} from "~/server/repo/background-jobs";
import {
  BACKGROUND_MESSAGE_VERSION,
  type BackgroundQueueProducer,
} from "./background-queue-types";

interface DispatchBackgroundJobsInput {
  kind: BackgroundJobKind;
  source: BackgroundBatchSource;
  metadata?: unknown;
  batchId?: string;
  jobs: CreateBackgroundJobInput[];
}

interface DispatchBackgroundJobsResult {
  batchId: string;
  jobIds: string[];
  batch: BackgroundBatchRef;
}

async function getDispatchedBatchRef(
  db: Database,
  batchId: string,
): Promise<BackgroundBatchRef> {
  const detail = await getBackgroundBatchDetail(db, batchId);
  if (!detail) {
    throw new Error(`Background batch ${batchId} was not found after dispatch`);
  }
  return toBackgroundBatchRef(detail);
}

async function processInlineJobs(
  db: Database,
  jobIds: string[],
): Promise<void> {
  // Deferred boundary: producer-side services never statically import handlers
  // that import those same services.
  const { processBackgroundJob } = await import("./background-queue");
  for (const jobId of jobIds) {
    let outcome = await processBackgroundJob(db, jobId);
    while (outcome === "retry") {
      outcome = await processBackgroundJob(db, jobId);
    }
  }
}

export async function dispatchBackgroundJobs(
  db: Database,
  input: DispatchBackgroundJobsInput,
): Promise<DispatchBackgroundJobsResult> {
  const result = input.batchId
    ? {
        batchId: input.batchId,
        jobIds: await addBackgroundJobsToBatch(db, input.batchId, input.jobs),
      }
    : await createBackgroundBatchWithJobs(db, input);

  if (result.jobIds.length === 0) {
    return {
      ...result,
      batch: await getDispatchedBatchRef(db, result.batchId),
    };
  }

  const queue = getBackgroundQueue();
  if (queue) {
    await setBackgroundBatchProcessor(db, result.batchId, "queue");
    await sendBackgroundMessages(
      queue,
      result.batchId,
      input.kind,
      result.jobIds,
    );
  } else {
    await setBackgroundBatchProcessor(db, result.batchId, "inline");
    await processInlineJobs(db, result.jobIds);
  }

  return {
    ...result,
    batch: await getDispatchedBatchRef(db, result.batchId),
  };
}

async function sendBackgroundMessages(
  queue: BackgroundQueueProducer,
  batchId: string,
  kind: BackgroundJobKind,
  jobIds: string[],
): Promise<void> {
  for (let index = 0; index < jobIds.length; index += 100) {
    await queue.sendBatch(
      jobIds.slice(index, index + 100).map((jobId) => ({
        body: {
          messageVersion: BACKGROUND_MESSAGE_VERSION,
          batchId,
          jobId,
          kind,
        },
      })),
    );
  }
}

export async function redispatchQueuedBatchJobs(
  db: Database,
  batchId: string,
): Promise<void> {
  const detail = await getBackgroundBatchDetail(db, batchId);
  if (!detail) return;
  const queuedJobIds = detail.jobs
    .filter((job) => job.status === "queued")
    .map((job) => job.id);
  if (queuedJobIds.length === 0) return;

  const queue = getBackgroundQueue();
  if (queue) {
    await setBackgroundBatchProcessor(db, batchId, "queue");
    await sendBackgroundMessages(queue, batchId, detail.kind, queuedJobIds);
  } else {
    await setBackgroundBatchProcessor(db, batchId, "inline");
    await processInlineJobs(db, queuedJobIds);
  }
}

export const dispatchLocationValuationRecompute = (
  db: Database,
  reason: string,
): Promise<DispatchBackgroundJobsResult> =>
  dispatchBackgroundJobs(db, {
    kind: "location-valuation.recompute",
    source: "mutation",
    metadata: { source: reason, reason },
    jobs: [
      {
        kind: "location-valuation.recompute",
        dedupeKey: "location-valuation.recompute",
        payload: { reason },
      },
    ],
  });

/**
 * Queue one canonical Problem-count refresh. Plain Node dev/tests have no KV
 * binding, so they retain the live-read fallback without making every mutation
 * synchronously run all detectors through the queue's inline adapter.
 */
export const dispatchProblemCountsRefresh = async (
  db: Database,
  source: BackgroundBatchSource,
  reason: string,
  requestedAt = new Date().toISOString(),
): Promise<DispatchBackgroundJobsResult | null> => {
  if (!getProblemCountsCache()) return null;
  return await dispatchBackgroundJobs(db, {
    kind: "problems.counts.refresh",
    source,
    metadata: { source: reason, requestedAt },
    jobs: [
      {
        kind: "problems.counts.refresh",
        dedupeKey: `problems.counts.refresh:${requestedAt}`,
        payload: { requestedAt },
      },
    ],
  });
};
