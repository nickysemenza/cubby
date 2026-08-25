import {
  backgroundBatchBrowserSummarySchema,
  backgroundBatchIdInputSchema,
} from "@cubby/schemas/background-jobs";
import type { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import { getBackgroundBatchSummary } from "~/server/repo/background-jobs";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";

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
    run: async (context, input) => {
      const batch = await getBackgroundBatchSummary(context.db, input.batchId);
      if (!batch) {
        throw createAppError(
          "BACKGROUND_BATCH_NOT_FOUND",
          "Background batch not found",
        );
      }
      return batch;
    },
  });
