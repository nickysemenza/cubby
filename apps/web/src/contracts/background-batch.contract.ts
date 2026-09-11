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

import { defineContract, mutation, query } from "~/contracts/define";

export const backgroundBatchContract = defineContract("background-batch", {
  list: query({
    input: backgroundBatchListInputSchema,
    output: backgroundBatchBrowserListOutSchema,
  }),
  summary: query({
    input: backgroundBatchIdInputSchema,
    output: backgroundBatchBrowserSummarySchema,
  }),
  jobs: query({
    input: backgroundBatchJobsInputSchema,
    output: backgroundBatchBrowserJobsOutSchema,
  }),
  retry: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
  }),
  cancel: mutation({
    input: backgroundBatchIdInputSchema,
    output: backgroundJobActionOutSchema,
  }),
});

export const backgroundJobContract = defineContract("background-job", {
  retry: mutation({
    input: backgroundJobIdInputSchema,
    output: backgroundJobActionOutSchema,
  }),
  drain: mutation({
    input: backgroundDrainInputSchema,
    output: backgroundDrainOutSchema,
  }),
  strandedCount: query({
    input: backgroundStrandedCountInputSchema,
    output: backgroundStrandedCountOutSchema,
  }),
  clearStranded: mutation({
    input: backgroundClearStrandedInputSchema,
    output: backgroundClearStrandedOutSchema,
  }),
});
