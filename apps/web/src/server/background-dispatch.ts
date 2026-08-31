import type {
  BackgroundBatchRef,
  BackgroundBatchSource,
  BackgroundJobKind,
} from "@cubby/schemas/background-jobs";
import { QUEUE_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";

import { getBackgroundQueue, getProblemCountsCache } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  addBackgroundJobsToBatch,
  type CreateBackgroundJobInput,
  createBackgroundBatchWithJobs,
  findRecoverableStrandedJobs,
  getBackgroundBatchSummary,
  getQueuedBackgroundBatchDispatch,
  setBackgroundBatchProcessor,
  toBackgroundBatchRef,
} from "~/server/repo/background-jobs";

import type { BackgroundQueueProducer } from "./background-queue-types";

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

/** Matches the default BackgroundJob.maxAttempts; the dev path should not exceed it. */
const INLINE_RETRY_LIMIT = 3;

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
    // Bounded because this runs inline on the dev request path: an uncapped
    // loop turns a job that always returns "retry" into a hung request with no
    // queue to back off against. The job's own maxAttempts still governs the
    // durable outcome; this only stops the in-process spin.
    for (
      let attempt = 1;
      outcome === "retry" && attempt < INLINE_RETRY_LIMIT;
      attempt++
    ) {
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
          version: QUEUE_MESSAGE_VERSION,
          queueType: "background",
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

/** One sweep stays well inside a scheduled invocation's budget. */
const STRANDED_SWEEP_LIMIT = 500;

/**
 * Replace queue wakeups that were lost, so a dispatch whose invocation died
 * mid-sendBatch heals on its own. This reconciles rather than retries: an
 * invocation killed by the CPU limit throws nothing for a catch block to see,
 * so the durable Postgres row is the only evidence the work exists.
 *
 * Redispatches a message instead of running the job inline (as
 * drainQueuedBackgroundJobs does) so each job gets its own fresh CPU budget —
 * running them here would reproduce the very failure being repaired.
 */
export async function sweepStrandedBackgroundJobs(
  db: Database,
  limit: number = STRANDED_SWEEP_LIMIT,
): Promise<{ redispatched: number; batches: number }> {
  const stranded = await findRecoverableStrandedJobs(db, limit);
  if (stranded.length === 0) return { redispatched: 0, batches: 0 };

  // No binding (Node dev) means dispatch ran these inline in-process; there is
  // no lost wakeup to replace, and enqueueing one would have nothing to drain it.
  const queue = getBackgroundQueue();
  if (!queue) return { redispatched: 0, batches: 0 };

  const jobIdsByBatch = new Map<string, string[]>();
  for (const job of stranded) {
    const existing = jobIdsByBatch.get(job.batchId);
    if (existing) existing.push(job.id);
    else jobIdsByBatch.set(job.batchId, [job.id]);
  }

  let redispatched = 0;
  for (const [batchId, jobIds] of jobIdsByBatch) {
    // The message carries the BATCH kind, not the job kind: a workflow's
    // coordinator and its children differ, and the consumer uses this to gate
    // continuation checks without a second read.
    const summary = await getBackgroundBatchSummary(db, batchId);
    if (!summary) continue;
    await sendBackgroundMessages(queue, batchId, summary.kind, jobIds);
    redispatched += jobIds.length;
  }
  return { redispatched, batches: jobIdsByBatch.size };
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
