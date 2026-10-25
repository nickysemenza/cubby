import {
  imageAnalysisHistoryInput,
  imageAnalysisHistoryOutput,
  retryImageProcessingInput,
  retryImageProcessingOutput,
} from "@cubby/schemas/activity";
import {
  pullCompanionImageProcessingInput,
  pullCompanionImageProcessingOutput,
  completeCompanionImageProcessingInput,
  completeCompanionImageProcessingOutput,
  releaseCompanionImageProcessingInput,
  releaseCompanionImageProcessingOutput,
  renewCompanionImageProcessingInput,
  renewCompanionImageProcessingOutput,
  evaluateAppleImageDescriptionInput,
  evaluateAppleImageDescriptionOutput,
  imageProcessingStatusInput,
  imageProcessingStatusOutput,
  scheduleImageProcessingInput,
  scheduleImageProcessingOutput,
} from "@cubby/schemas/image-processing";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * The native annotations deliberately anchor the companion's generated client
 * aliases. WebSocket transport is a delivery detail; these operations expose
 * the same durable job state to every supported client.
 */
export const imageProcessingContract = defineContract(
  "imageProcessing",
  {
    pull: mutation({
      exposure: "view",
      input: pullCompanionImageProcessingInput,
      output: pullCompanionImageProcessingOutput,
    }),
    complete: mutation({
      exposure: "view",
      input: completeCompanionImageProcessingInput,
      output: completeCompanionImageProcessingOutput,
      invalidates: ["image", "product"],
    }),
    release: mutation({
      exposure: "view",
      input: releaseCompanionImageProcessingInput,
      output: releaseCompanionImageProcessingOutput,
    }),
    renew: mutation({
      exposure: "view",
      input: renewCompanionImageProcessingInput,
      output: renewCompanionImageProcessingOutput,
    }),
    analyses: query({
      exposure: "view",
      input: imageAnalysisHistoryInput,
      output: imageAnalysisHistoryOutput,
      cache: { tags: [["image"]] },
    }),
    retry: mutation({
      exposure: "capability",
      note: "Agents re-run processing through image.schedule",
      description:
        "Retry image processing for the specified image after correcting the cause of its failure. Inspect image status first; this schedules work and does not change the source file.",
      command: { label: "Retry failed image processing", confirmation: null },
      input: retryImageProcessingInput,
      output: retryImageProcessingOutput,
      invalidates: ["image"],
    }),
    status: query({
      exposure: "capability",
      description:
        "An image's durable description and transparent-cutout processing status.",
      input: imageProcessingStatusInput,
      output: imageProcessingStatusOutput,
      cache: { tags: [["image"]] },
    }),
    schedule: mutation({
      exposure: "capability",
      description:
        "Schedule processing for an uploaded image. Omitting kinds queues independent Apple and cloud descriptions, transparent subject-lift cutouts, and Clef Product identification. Supply kinds to request a subset. Cloud descriptions and Clef identification use billable AI calls; retained work is reused for the same content and processor revision. Identification saves unconfirmed suggestions and never attaches records or changes inventory.",
      input: scheduleImageProcessingInput,
      output: scheduleImageProcessingOutput,
      invalidates: ["image"],
    }),
    evaluateAppleDescription: mutation({
      input: evaluateAppleImageDescriptionInput,
      output: evaluateAppleImageDescriptionOutput,
      invalidates: ["image"],
    }),
  },
  { exposure: "internal", mcpToolGroup: "image" },
);
