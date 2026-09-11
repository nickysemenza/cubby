import {
  backgroundBatchBrowserJobsOutSchema,
  backgroundBatchBrowserListOutSchema,
  backgroundBatchBrowserSummarySchema,
} from "@cubby/schemas/background-jobs";

import {
  backgroundBatchContract,
  backgroundJobContract,
} from "~/contracts/background-batch.contract";
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
  backgroundBatchContract,
  {
    list: {
      run: async (context, input) =>
        backgroundBatchBrowserListOutSchema.parse(
          await listBackgroundBatchesWorkflow(context.db, input),
        ),
    },
    summary: {
      run: async (context, input) =>
        backgroundBatchBrowserSummarySchema.parse(
          await getBackgroundBatchSummaryWorkflow(context.db, input),
        ),
    },
    jobs: {
      run: async (context, input) =>
        backgroundBatchBrowserJobsOutSchema.parse(
          await listBackgroundBatchJobsWorkflow(context.db, input),
        ),
    },
    retry: (context, input) => retryBackgroundBatchWorkflow(context.db, input),
    cancel: (context, input) =>
      cancelBackgroundBatchWorkflow(context.db, input),
  },
);

export const backgroundJobHandlers = implementOperationDomain(
  backgroundJobContract,
  {
    retry: (context, input) => retryBackgroundJobWorkflow(context.db, input),
    drain: (context, input) => drainBackgroundJobsWorkflow(context.db, input),
    strandedCount: {
      run: (context) => countStrandedBackgroundJobsWorkflow(context.db),
    },
    clearStranded: (context, input) =>
      clearStrandedBackgroundJobsWorkflow(context.db, input),
  },
);
