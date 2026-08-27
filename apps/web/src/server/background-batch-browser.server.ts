import {
  backgroundBatch,
  backgroundJob,
} from "~/lib/background-batch.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  cancelBackgroundBatchWorkflow,
  clearStrandedBackgroundJobsWorkflow,
  countStrandedBackgroundJobsWorkflow,
  drainBackgroundJobsWorkflow,
  getBackgroundBatchSummaryWorkflow,
  listBackgroundBatchesWorkflow,
  listBackgroundBatchJobsWorkflow,
  retryBackgroundBatchWorkflow,
  retryBackgroundJobWorkflow,
} from "~/server/workflows/background-jobs.server";

export const backgroundBatchHandlers = implementOperationDomain(
  backgroundBatch,
  {
    list: {
      readPolicy: "strong",
      run: (context, input) => listBackgroundBatchesWorkflow(context.db, input),
    },
    summary: {
      readPolicy: "strong",
      run: (context, input) =>
        getBackgroundBatchSummaryWorkflow(context.db, input),
    },
    jobs: {
      readPolicy: "strong",
      run: (context, input) =>
        listBackgroundBatchJobsWorkflow(context.db, input),
    },
    retry: (context, input) => retryBackgroundBatchWorkflow(context.db, input),
    cancel: (context, input) =>
      cancelBackgroundBatchWorkflow(context.db, input),
  },
);

export const backgroundJobHandlers = implementOperationDomain(backgroundJob, {
  retry: (context, input) => retryBackgroundJobWorkflow(context.db, input),
  drain: (context, input) => drainBackgroundJobsWorkflow(context.db, input),
  strandedCount: {
    readPolicy: "strong",
    run: (context) => countStrandedBackgroundJobsWorkflow(context.db),
  },
  clearStranded: (context, input) =>
    clearStrandedBackgroundJobsWorkflow(context.db, input),
});
