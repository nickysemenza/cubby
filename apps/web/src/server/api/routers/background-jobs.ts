import {
  backgroundBatchDetailSchema,
  backgroundBatchIdInputSchema,
  backgroundBatchListInputSchema,
  backgroundBatchListOutSchema,
  backgroundDrainInputSchema,
  backgroundDrainOutSchema,
  backgroundJobIdInputSchema,
} from "@cubby/schemas/background-jobs";
import { drainQueuedBackgroundJobs } from "~/server/background-queue";
import { createAppError } from "~/server/errors/app-error";
import {
  cancelQueuedJobsForBatch,
  getBackgroundBatchDetail,
  listBackgroundBatches,
  retryBackgroundJob,
  retryFailedJobsForBatch,
} from "~/server/repo/background-jobs";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const backgroundJobsRouter = createTRPCRouter({
  listBatches: protectedProcedure
    .input(backgroundBatchListInputSchema)
    .output(backgroundBatchListOutSchema)
    .query(async ({ ctx, input }) => {
      return await listBackgroundBatches(ctx.db, input.limit);
    }),
  getBatch: protectedProcedure
    .input(backgroundBatchIdInputSchema)
    .output(backgroundBatchDetailSchema)
    .query(async ({ ctx, input }) => {
      const batch = await getBackgroundBatchDetail(ctx.db, input.batchId);
      if (!batch) {
        throw createAppError(
          "BACKGROUND_BATCH_NOT_FOUND",
          "Background batch not found",
        );
      }
      return batch;
    }),
  retryBatch: protectedProcedure
    .input(backgroundBatchIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await retryFailedJobsForBatch(ctx.db, input.batchId);
      return { ok: true };
    }),
  retryJob: protectedProcedure
    .input(backgroundJobIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await retryBackgroundJob(ctx.db, input.jobId);
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
    .output(backgroundDrainOutSchema)
    .mutation(async ({ ctx, input }) => {
      return await drainQueuedBackgroundJobs(ctx.db, input.limit);
    }),
});
