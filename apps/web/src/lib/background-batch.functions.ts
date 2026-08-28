import {
  backgroundBatchBrowserJobsOutSchema,
  backgroundBatchBrowserListOutSchema,
  backgroundBatchBrowserSummarySchema,
  backgroundBatchIdInputSchema,
  backgroundBatchJobsInputSchema,
  backgroundBatchListInputSchema,
  backgroundClearStrandedInputSchema,
  backgroundClearStrandedOutSchema,
  backgroundDrainInputSchema,
  backgroundDrainOutSchema,
  backgroundJobActionOutSchema,
  backgroundJobIdInputSchema,
  backgroundStrandedCountInputSchema,
  backgroundStrandedCountOutSchema,
} from "@cubby/schemas/background-jobs";

import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const backgroundBatch = defineOperationDomain("background-batch", {
  list: query({
    input: backgroundBatchListInputSchema,
    output: backgroundBatchBrowserListOutSchema,
    tags: [["background-batch", "list"]],
  }),
  summary: query({
    input: backgroundBatchIdInputSchema,
    output: backgroundBatchBrowserSummarySchema,
    tags: [["background-batch", "summary"]],
    freshness: { staleTime: 0 },
  }),
  jobs: query({
    input: backgroundBatchJobsInputSchema,
    output: backgroundBatchBrowserJobsOutSchema,
    tags: [["background-batch", "jobs"]],
  }),
  retry: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: [["background-batch"]],
  }),
  cancel: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: [["background-batch"]],
  }),
});

export const backgroundJob = defineOperationDomain("background-job", {
  retry: mutation({
    input: backgroundJobIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: [["background-batch"]],
  }),
  drain: mutation({
    input: backgroundDrainInputSchema,
    output: backgroundDrainOutSchema,
    invalidates: [["background-batch"]],
  }),
  strandedCount: query({
    input: backgroundStrandedCountInputSchema,
    output: backgroundStrandedCountOutSchema,
    tags: [["background-batch", "stranded"]],
  }),
  clearStranded: mutation({
    input: backgroundClearStrandedInputSchema,
    output: backgroundClearStrandedOutSchema,
    invalidates: [["background-batch"]],
  }),
});
