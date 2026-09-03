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

import { ripple } from "~/integrations/tanstack-query/cache-tags";
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
    cache: "live-status",
  }),
  jobs: query({
    input: backgroundBatchJobsInputSchema,
    output: backgroundBatchBrowserJobsOutSchema,
    tags: [["background-batch", "jobs"]],
  }),
  retry: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: ripple.backgroundBatch,
  }),
  cancel: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: ripple.backgroundBatch,
  }),
});

export const backgroundJob = defineOperationDomain("background-job", {
  retry: mutation({
    input: backgroundJobIdInputSchema,
    output: backgroundJobActionOutSchema,
    invalidates: ripple.backgroundBatch,
  }),
  drain: mutation({
    input: backgroundDrainInputSchema,
    output: backgroundDrainOutSchema,
    invalidates: ripple.backgroundBatch,
  }),
  strandedCount: query({
    input: backgroundStrandedCountInputSchema,
    output: backgroundStrandedCountOutSchema,
    tags: [["background-batch", "stranded"]],
  }),
  clearStranded: mutation({
    input: backgroundClearStrandedInputSchema,
    output: backgroundClearStrandedOutSchema,
    invalidates: ripple.backgroundBatch,
  }),
});
