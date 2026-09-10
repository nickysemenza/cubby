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
  callStep,
  committedCallStep,
  committedEffectStep,
  defineWorkflow,
  defineWorkflowFunction,
  defineWorkflowOperation,
  bindWorkflow,
  mapWorkflowValue,
  workflowInput,
  workflowStepOutput,
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

const loadBackgroundBatch = defineWorkflowFunction<
  Database,
  BatchSummaryInput,
  Awaited<ReturnType<typeof getBackgroundBatchSummary>>
>("background-batch.loadSummary", async ({ context }, input) =>
  getBackgroundBatchSummary(context, input.batchId),
);
const requireBackgroundBatch = defineWorkflowFunction<
  Database,
  Awaited<ReturnType<typeof getBackgroundBatchSummary>>,
  NonNullable<Awaited<ReturnType<typeof getBackgroundBatchSummary>>>
>("background-batch.requireSummary", async (_, batch) => {
  if (!batch)
    throw createAppError(
      "BACKGROUND_BATCH_NOT_FOUND",
      "Background batch not found",
    );
  return batch;
});
const backgroundBatchSummaryStep = callStep({
  name: "loadSummary",
  fn: loadBackgroundBatch,
  input: workflowInput<BatchSummaryInput>(),
});
const backgroundBatchRequiredStep = callStep({
  name: "requireSummary",
  fn: requireBackgroundBatch,
  input: workflowStepOutput(backgroundBatchSummaryStep),
});
const backgroundBatchSummaryWorkflow = defineWorkflow({
  name: "background-batch.summary",
  steps: [backgroundBatchSummaryStep, backgroundBatchRequiredStep],
  output: backgroundBatchRequiredStep.output,
});

const retryFailedBatch = defineWorkflowFunction<Database, BatchInput, void>(
  "background-batch.retryFailed",
  async ({ context }, input) => {
    await retryFailedJobsForBatch(context, input.batchId);
  },
);
const redispatchBatch = defineWorkflowFunction<Database, BatchInput, void>(
  "background-batch.redispatch",
  async ({ context }, input) => {
    await redispatchQueuedBatchJobs(context, input.batchId);
  },
);
const retryBatchStep = committedCallStep({
  name: "retryFailed",
  fn: retryFailedBatch,
  input: workflowInput<BatchInput>(),
});
const redispatchBatchStep = committedEffectStep({
  name: "redispatch",
  fn: redispatchBatch,
  input: workflowInput<BatchInput>(),
});
const retryBackgroundBatchWorkflowDefinition = defineWorkflow({
  name: "background-batch.retry",
  steps: [retryBatchStep, redispatchBatchStep],
  output: mapWorkflowValue(redispatchBatchStep.output, () => ({
    ok: true as const,
  })),
});

const retryJob = defineWorkflowFunction<Database, JobInput, string | null>(
  "background-job.retry",
  async ({ context }, input) => retryBackgroundJob(context, input.jobId),
);
const redispatchRetriedJob = defineWorkflowFunction<
  Database,
  string | null,
  undefined
>("background-job.redispatch", async ({ context }, batchId) => {
  if (batchId) await redispatchQueuedBatchJobs(context, batchId);
});
const retryJobStep = committedCallStep({
  name: "retry",
  fn: retryJob,
  input: workflowInput<JobInput>(),
});
const redispatchRetriedJobStep = committedEffectStep({
  name: "redispatchIfRetried",
  fn: redispatchRetriedJob,
  input: workflowStepOutput(retryJobStep),
});
const retryBackgroundJobWorkflowDefinition = defineWorkflow({
  name: "background-job.retry",
  steps: [retryJobStep, redispatchRetriedJobStep],
  output: mapWorkflowValue(redispatchRetriedJobStep.output, () => ({
    ok: true as const,
  })),
});

const cancelBatch = defineWorkflowFunction<Database, BatchInput, { ok: true }>(
  "background-batch.cancelQueued",
  async ({ context }, input) => {
    await cancelQueuedJobsForBatch(context, input.batchId);
    return { ok: true as const };
  },
);
const cancelBatchStep = committedCallStep({
  name: "cancel",
  fn: cancelBatch,
  input: workflowInput<BatchInput>(),
});
const cancelBackgroundBatchWorkflowDefinition = defineWorkflow({
  name: "background-batch.cancel",
  steps: [cancelBatchStep],
  output: cancelBatchStep.output,
});

const countStranded = defineWorkflowFunction<
  Database,
  undefined,
  { abandoned: number }
>("background-job.countStranded", async ({ context }) => ({
  abandoned: await countAbandonedStrandedJobs(context),
}));
const countStrandedStep = callStep({
  name: "count",
  fn: countStranded,
  input: workflowInput<undefined>(),
});
const countStrandedBackgroundJobsWorkflowDefinition = defineWorkflow({
  name: "background-job.strandedCount",
  steps: [countStrandedStep],
  output: countStrandedStep.output,
});

const clearStranded = defineWorkflowFunction<
  Database,
  LimitInput,
  Awaited<ReturnType<typeof cancelAbandonedStrandedJobs>>
>("background-job.clearStranded", async ({ context }, input) =>
  cancelAbandonedStrandedJobs(context, input.limit),
);
const clearStrandedStep = committedCallStep({
  name: "clear",
  fn: clearStranded,
  input: workflowInput<LimitInput>(),
});
const clearStrandedBackgroundJobsWorkflowDefinition = defineWorkflow({
  name: "background-job.clearStranded",
  steps: [clearStrandedStep],
  output: clearStrandedStep.output,
});

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
