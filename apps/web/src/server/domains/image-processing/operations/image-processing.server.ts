import { imageProcessingContract } from "~/contracts/image-processing.contract";
import {
  getImageProcessingReadProjection,
  releaseAssignedImageProcessingJob,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  pullCompanionImageProcessing,
  completeAssignedCompanionImageProcessing,
} from "~/server/domains/image-processing/service/image-processing.service";
import { retryImageProcessingFailures } from "~/server/domains/image-processing/service/image-processing.service";
import {
  scheduleAppleImageDescriptionEvaluation,
  scheduleImageProcessingJobs,
} from "~/server/domains/image-processing/service/image-processing.service";
import { imageAnalysisHistory } from "~/server/domains/image/repo/image-analysis-history";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const imageProcessingHandlers = implementOperationDomain(
  imageProcessingContract,
  {
    // The WebSocket route performs the same parsed-message admission. Returning
    // null is intentional: a command is leased only after a capable device is
    // selected, never as a side effect of a validation probe.
    pull: async (context, input) =>
      pullCompanionImageProcessing(
        context.db,
        input,
        context.actorContext.userId,
      ),
    complete: async (context, input) =>
      completeAssignedCompanionImageProcessing(
        context.db,
        input,
        context.actorContext.userId,
      ),
    release: async (context, input) => ({
      released: await releaseAssignedImageProcessingJob(context.db, {
        ...input,
        userId: context.actorContext.userId,
      }),
    }),
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
  },
);
