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
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export const listBackgroundBatchesWorkflow = defineWorkflowOperation(
  "background-batch.list",
  (db: Database, input: { limit: number }) =>
    listBackgroundBatches(db, input.limit),
);

type BatchSummaryInput = { batchId: string };
type BatchInput = { batchId: string };
type JobInput = { jobId: string };
type LimitInput = { limit: number };

const backgroundBatchSummaryWorkflow = workflow<Database, BatchSummaryInput>(
  "background-batch.summary",
)
  .call("loadSummary", ({ context }, { input }) =>
    getBackgroundBatchSummary(context, input.batchId),
  )
  .call("requireSummary", async (_, { loadSummary }) => {
    if (!loadSummary)
      throw createAppError(
        "BACKGROUND_BATCH_NOT_FOUND",
        "Background batch not found",
      );
    return loadSummary;
  })
  .output(({ requireSummary }) => requireSummary);

const retryBackgroundBatchWorkflowDefinition = workflow<Database, BatchInput>(
  "background-batch.retry",
)
  .commit("retryFailed", async ({ context }, { input }) =>
    retryFailedJobsForBatch(context, input.batchId),
  )
  .effect("redispatch", async ({ context }, { input }) =>
    redispatchQueuedBatchJobs(context, input.batchId),
  )
  .output(() => ({ ok: true as const }));

const retryBackgroundJobWorkflowDefinition = workflow<Database, JobInput>(
  "background-job.retry",
)
  .commit("retry", async ({ context }, { input }) =>
    retryBackgroundJob(context, input.jobId),
  )
  .effect("redispatchIfRetried", async ({ context }, { retry }) => {
    if (retry) await redispatchQueuedBatchJobs(context, retry);
  })
  .output(() => ({ ok: true as const }));

const cancelBackgroundBatchWorkflowDefinition = workflow<Database, BatchInput>(
  "background-batch.cancel",
)
  .commit("cancel", async ({ context }, { input }) => {
    await cancelQueuedJobsForBatch(context, input.batchId);
    return { ok: true as const };
  })
  .output(({ cancel }) => cancel);

const countStrandedBackgroundJobsWorkflowDefinition = workflow<
  Database,
  undefined
>("background-job.strandedCount")
  .call("count", async ({ context }) => ({
    abandoned: await countAbandonedStrandedJobs(context),
  }))
  .output(({ count }) => count);

const clearStrandedBackgroundJobsWorkflowDefinition = workflow<
  Database,
  LimitInput
>("background-job.clearStranded")
  .commit("clear", ({ context }, { input }) =>
    cancelAbandonedStrandedJobs(context, input.limit),
  )
  .output(({ clear }) => clear);

export const getBackgroundBatchSummaryWorkflow = bindWorkflow(
  backgroundBatchSummaryWorkflow,
  (db: Database, input: BatchSummaryInput) => ({ context: db, input }),
);
export const listBackgroundBatchJobsWorkflow = defineWorkflowOperation(
  "background-batch.jobs",
  listBackgroundBatchJobs,
);
export const retryBackgroundBatchWorkflow = bindWorkflow(
  retryBackgroundBatchWorkflowDefinition,
  (db: Database, input: BatchInput) => ({
    context: db,
    input,
  }),
);
export const retryBackgroundJobWorkflow = bindWorkflow(
  retryBackgroundJobWorkflowDefinition,
  (db: Database, input: JobInput) => ({ context: db, input }),
);
export const cancelBackgroundBatchWorkflow = bindWorkflow(
  cancelBackgroundBatchWorkflowDefinition,
  (db: Database, input: BatchInput) => ({
    context: db,
    input,
  }),
);
export const drainBackgroundJobsWorkflow = bindWorkflow(
  drainQueuedBackgroundJobs.definition,
  (db: Database, input: LimitInput) => ({
    context: db,
    input,
  }),
);
export const countStrandedBackgroundJobsWorkflow = bindWorkflow(
  countStrandedBackgroundJobsWorkflowDefinition,
  (db: Database) => ({
    context: db,
    input: undefined,
  }),
);
export const clearStrandedBackgroundJobsWorkflow = bindWorkflow(
  clearStrandedBackgroundJobsWorkflowDefinition,
  (db: Database, input: LimitInput) => ({
    context: db,
    input,
  }),
);
