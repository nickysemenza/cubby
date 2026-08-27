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
import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
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

export const listBackgroundBatchesForBrowser = async (options: {
  data: z.input<typeof backgroundBatchListInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-batch.list",
    type: "query",
    input: options.data,
    inputSchema: backgroundBatchListInputSchema,
    outputSchema: backgroundBatchBrowserListOutSchema,
    request: options.request,
    readPolicy: "strong",
    run: (context, input) => listBackgroundBatchesWorkflow(context.db, input),
  });

export const getBackgroundBatchSummaryForBrowser = async (options: {
  data: z.input<typeof backgroundBatchIdInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-batch.summary",
    type: "query",
    input: options.data,
    inputSchema: backgroundBatchIdInputSchema,
    outputSchema: backgroundBatchBrowserSummarySchema,
    request: options.request,
    readPolicy: "strong",
    run: (context, input) =>
      getBackgroundBatchSummaryWorkflow(context.db, input),
  });

export const listBackgroundBatchJobsForBrowser = async (options: {
  data: z.input<typeof backgroundBatchJobsInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-batch.jobs",
    type: "query",
    input: options.data,
    inputSchema: backgroundBatchJobsInputSchema,
    outputSchema: backgroundBatchBrowserJobsOutSchema,
    request: options.request,
    readPolicy: "strong",
    run: (context, input) => listBackgroundBatchJobsWorkflow(context.db, input),
  });

export const retryBackgroundBatchForBrowser = async (options: {
  data: z.input<typeof backgroundBatchIdInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-batch.retry",
    type: "mutation",
    input: options.data,
    inputSchema: backgroundBatchIdInputSchema,
    outputSchema: backgroundJobActionOutSchema,
    request: options.request,
    run: (context, input) => retryBackgroundBatchWorkflow(context.db, input),
  });

export const retryBackgroundJobForBrowser = async (options: {
  data: z.input<typeof backgroundJobIdInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-job.retry",
    type: "mutation",
    input: options.data,
    inputSchema: backgroundJobIdInputSchema,
    outputSchema: backgroundJobActionOutSchema,
    request: options.request,
    run: (context, input) => retryBackgroundJobWorkflow(context.db, input),
  });

export const cancelBackgroundBatchForBrowser = async (options: {
  data: z.input<typeof backgroundBatchIdInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-batch.cancel",
    type: "mutation",
    input: options.data,
    inputSchema: backgroundBatchIdInputSchema,
    outputSchema: backgroundJobActionOutSchema,
    request: options.request,
    run: (context, input) => cancelBackgroundBatchWorkflow(context.db, input),
  });

export const drainBackgroundJobsForBrowser = async (options: {
  data: z.input<typeof backgroundDrainInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-job.drain",
    type: "mutation",
    input: options.data,
    inputSchema: backgroundDrainInputSchema,
    outputSchema: backgroundDrainOutSchema,
    request: options.request,
    run: (context, input) => drainBackgroundJobsWorkflow(context.db, input),
  });

export const countStrandedBackgroundJobsForBrowser = async (options: {
  data: z.input<typeof backgroundStrandedCountInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-job.strandedCount",
    type: "query",
    input: options.data,
    inputSchema: backgroundStrandedCountInputSchema,
    outputSchema: backgroundStrandedCountOutSchema,
    request: options.request,
    readPolicy: "strong",
    run: (context) => countStrandedBackgroundJobsWorkflow(context.db),
  });

export const clearStrandedBackgroundJobsForBrowser = async (options: {
  data: z.input<typeof backgroundClearStrandedInputSchema>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "background-job.clearStranded",
    type: "mutation",
    input: options.data,
    inputSchema: backgroundClearStrandedInputSchema,
    outputSchema: backgroundClearStrandedOutSchema,
    request: options.request,
    run: (context, input) =>
      clearStrandedBackgroundJobsWorkflow(context.db, input),
  });
