import { imageProcessingContract } from "~/contracts/image-processing.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { imageAnalysisHistory } from "~/server/repo/activity";
import {
  getImageProcessingReadProjection,
  saveImageDescriptionCorrection,
} from "~/server/repo/image-processing";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { retryImageProcessingFailures } from "~/server/services/image-processing.service";
import {
  scheduleAppleImageDescriptionEvaluation,
  scheduleImageProcessingJobs,
} from "~/server/services/image-processing.service";

export const imageProcessingHandlers = implementOperationDomain(
  imageProcessingContract,
  {
    // The WebSocket route performs the same parsed-message admission. Returning
    // null is intentional: a command is leased only after a capable device is
    // selected, never as a side effect of a validation probe.
    validateCompanionMessage: async () => ({ message: null }),
    status: async (context, input) =>
      getImageProcessingReadProjection(
        context.db,
        await resolveOrThrow(context.db, "image", input.id),
      ),
    analyses: async (context, input) => imageAnalysisHistory(context.db, input),
    retry: async (context, input) =>
      retryImageProcessingFailures(context.db, input),
    schedule: async (context, input) =>
      scheduleImageProcessingJobs(context.db, input),
    evaluateAppleDescription: async (context, input) =>
      scheduleAppleImageDescriptionEvaluation(context.db, input),
    correctDescription: async (context, input) => {
      await saveImageDescriptionCorrection(context.db, {
        imageId: await resolveOrThrow(context.db, "image", input.id),
        description: input.description,
      });
      return { saved: true as const };
    },
  },
);
