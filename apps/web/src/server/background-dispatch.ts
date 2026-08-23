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
  getBackgroundBatchSummary,
  getQueuedBackgroundBatchDispatch,
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
  const summary = await getBackgroundBatchSummary(db, batchId);
  if (!summary) {
    throw new Error(`Background batch ${batchId} was not found after dispatch`);
  }
  return toBackgroundBatchRef(summary);
}

async function processInlineJobs(
  db: Database,
  jobIds: string[],
  batchKind: BackgroundJobKind,
): Promise<void> {
  // Deferred boundary: producer-side services never statically import handlers
  // that import those same services.
  const { processBackgroundJob } = await import("./background-queue");
  for (const jobId of jobIds) {
    let outcome = await processBackgroundJob(db, jobId, batchKind);
    while (outcome === "retry") {
      outcome = await processBackgroundJob(db, jobId, batchKind);
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
    await processInlineJobs(db, result.jobIds, input.kind);
  }

  return {
    ...result,
    batch: await getDispatchedBatchRef(db, result.batchId),
  };
}

async function sendBackgroundMessages(
  queue: BackgroundQueueProducer,
  batchId: string,
  batchKind: BackgroundJobKind,
  jobIds: string[],
): Promise<void> {
  for (let index = 0; index < jobIds.length; index += 100) {
    await queue.sendBatch(
      jobIds.slice(index, index + 100).map((jobId) => ({
        body: {
          messageVersion: BACKGROUND_MESSAGE_VERSION,
          batchId,
          jobId,
          kind: batchKind,
        },
      })),
    );
  }
}

/** Deliver persisted queued jobs without re-reading their potentially wide payloads. */
export async function dispatchQueuedBackgroundJobs(
  db: Database,
  input: { batchId: string; jobIds: string[]; batchKind: BackgroundJobKind },
): Promise<void> {
  if (input.jobIds.length === 0) return;
  const queue = getBackgroundQueue();
  if (queue) {
    await setBackgroundBatchProcessor(db, input.batchId, "queue");
    await sendBackgroundMessages(
      queue,
      input.batchId,
      input.batchKind,
      input.jobIds,
    );
  } else {
    await setBackgroundBatchProcessor(db, input.batchId, "inline");
    await processInlineJobs(db, input.jobIds, input.batchKind);
  }
}

/** Deliver one already-persisted queued job, used for workflow continuations. */
export async function dispatchQueuedBackgroundJob(
  db: Database,
  input: { batchId: string; jobId: string; batchKind: BackgroundJobKind },
): Promise<void> {
  await dispatchQueuedBackgroundJobs(db, {
    batchId: input.batchId,
    jobIds: [input.jobId],
    batchKind: input.batchKind,
  });
}

export async function redispatchQueuedBatchJobs(
  db: Database,
  batchId: string,
): Promise<void> {
  const dispatch = await getQueuedBackgroundBatchDispatch(db, batchId);
  if (!dispatch || dispatch.jobIds.length === 0) return;

  const queue = getBackgroundQueue();
  if (queue) {
    await setBackgroundBatchProcessor(db, batchId, "queue");
    await sendBackgroundMessages(
      queue,
      batchId,
      dispatch.kind,
      dispatch.jobIds,
    );
  } else {
    await setBackgroundBatchProcessor(db, batchId, "inline");
    await processInlineJobs(db, dispatch.jobIds, dispatch.kind);
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
