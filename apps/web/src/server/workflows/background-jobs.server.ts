import { redispatchQueuedBatchJobs } from "~/server/background-dispatch";
import { drainQueuedBackgroundJobs } from "~/server/background-queue";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  cancelAbandonedStrandedJobs,
  cancelQueuedJobsForBatch,
  countAbandonedStrandedJobs,
  getBackgroundBatchSummary,
  listBackgroundBatches,
  listBackgroundBatchJobs,
  retryBackgroundJob,
  retryFailedJobsForBatch,
} from "~/server/repo/background-jobs";

export const listBackgroundBatchesWorkflow = async (
  db: Database,
  input: { limit: number },
) => await listBackgroundBatches(db, input.limit);

export const getBackgroundBatchSummaryWorkflow = async (
  db: Database,
  input: { batchId: string },
) => {
  const batch = await getBackgroundBatchSummary(db, input.batchId);
  if (!batch) {
    throw createAppError(
      "BACKGROUND_BATCH_NOT_FOUND",
      "Background batch not found",
    );
  }
  return batch;
};

export const listBackgroundBatchJobsWorkflow = async (
  db: Database,
  input: {
    batchId: string;
    pageIndex: number;
    pageSize: number;
    failedOnly: boolean;
  },
) => await listBackgroundBatchJobs(db, input);

export const retryBackgroundBatchWorkflow = async (
  db: Database,
  input: { batchId: string },
) => {
  await retryFailedJobsForBatch(db, input.batchId);
  await redispatchQueuedBatchJobs(db, input.batchId);
  return { ok: true as const };
};

export const retryBackgroundJobWorkflow = async (
  db: Database,
  input: { jobId: string },
) => {
  const batchId = await retryBackgroundJob(db, input.jobId);
  if (batchId) await redispatchQueuedBatchJobs(db, batchId);
  return { ok: true as const };
};

export const cancelBackgroundBatchWorkflow = async (
  db: Database,
  input: { batchId: string },
) => {
  await cancelQueuedJobsForBatch(db, input.batchId);
  return { ok: true as const };
};

export const drainBackgroundJobsWorkflow = async (
  db: Database,
  input: { limit: number },
) => await drainQueuedBackgroundJobs(db, input.limit);

export const countStrandedBackgroundJobsWorkflow = async (db: Database) => ({
  abandoned: await countAbandonedStrandedJobs(db),
});

export const clearStrandedBackgroundJobsWorkflow = async (
  db: Database,
  input: { limit: number },
) => await cancelAbandonedStrandedJobs(db, input.limit);
