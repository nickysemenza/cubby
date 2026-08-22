import {
  backgroundBatchIdInputSchema,
  backgroundBatchJobsInputSchema,
  backgroundBatchJobsOutSchema,
  backgroundBatchListInputSchema,
  backgroundBatchListOutSchema,
  backgroundBatchSummarySchema,
  backgroundDrainInputSchema,
  backgroundDrainOutSchema,
  backgroundJobIdInputSchema,
} from "@cubby/schemas/background-jobs";
import { redispatchQueuedBatchJobs } from "~/server/background-dispatch";
import { drainQueuedBackgroundJobs } from "~/server/background-queue";
import { createAppError } from "~/server/errors/app-error";
import {
  cancelQueuedJobsForBatch,
  getBackgroundBatchSummary,
  listBackgroundBatches,
  listBackgroundBatchJobs,
  retryBackgroundJob,
  retryFailedJobsForBatch,
} from "~/server/repo/background-jobs";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const backgroundJobsRouter = createTRPCRouter({
  listBatches: protectedProcedure
    .input(backgroundBatchListInputSchema)
    .output(strictOutput(backgroundBatchListOutSchema))
    .query(async ({ ctx, input }) => {
      return await listBackgroundBatches(ctx.db, input.limit);
    }),
  getBatchSummary: protectedProcedure
    .input(backgroundBatchIdInputSchema)
    .output(strictOutput(backgroundBatchSummarySchema))
    .query(async ({ ctx, input }) => {
      const batch = await getBackgroundBatchSummary(ctx.db, input.batchId);
      if (!batch) {
        throw createAppError(
          "BACKGROUND_BATCH_NOT_FOUND",
          "Background batch not found",
        );
      }
      return batch;
    }),
  listBatchJobs: protectedProcedure
    .input(backgroundBatchJobsInputSchema)
    .output(strictOutput(backgroundBatchJobsOutSchema))
    .query(async ({ ctx, input }) => {
      return await listBackgroundBatchJobs(ctx.db, input);
    }),
  retryBatch: protectedProcedure
    .input(backgroundBatchIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await retryFailedJobsForBatch(ctx.db, input.batchId);
      // Retry only resets DB status; re-dispatch so the prod queue consumer
      // (or dev inline drain) actually picks the jobs back up.
      await redispatchQueuedBatchJobs(ctx.db, input.batchId);
      return { ok: true };
    }),
  retryJob: protectedProcedure
    .input(backgroundJobIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const batchId = await retryBackgroundJob(ctx.db, input.jobId);
      if (batchId) await redispatchQueuedBatchJobs(ctx.db, batchId);
      return { ok: true };
    }),
  cancelBatch: protectedProcedure
    .input(backgroundBatchIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await cancelQueuedJobsForBatch(ctx.db, input.batchId);
      return { ok: true };
    }),
  drain: protectedProcedure
    .input(backgroundDrainInputSchema)
    .output(strictOutput(backgroundDrainOutSchema))
    .mutation(async ({ ctx, input }) => {
      return await drainQueuedBackgroundJobs(ctx.db, input.limit);
    }),
});
