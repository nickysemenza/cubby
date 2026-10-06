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
  imageDescriptionCorrectionInput,
  imageDescriptionCorrectionOutput,
  evaluateAppleImageDescriptionInput,
  evaluateAppleImageDescriptionOutput,
  imageProcessingStatusInput,
  imageProcessingStatusOutput,
  scheduleImageProcessingInput,
  scheduleImageProcessingOutput,
  validateImageProcessingCompanionMessageInput,
  validateImageProcessingCompanionMessageOutput,
} from "@cubby/schemas/image-processing";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * The native annotations deliberately anchor the companion's generated client
 * aliases. WebSocket transport is a delivery detail; these operations expose
 * the same durable job state to every supported client.
 */
export const imageProcessingContract = defineContract("imageProcessing", {
  pull: mutation({
    mcp: { omit: "device_protocol" },
    native: "Pull leased companion work in a background window",
    input: pullCompanionImageProcessingInput,
    output: pullCompanionImageProcessingOutput,
  }),
  complete: mutation({
    mcp: { omit: "device_protocol" },
    native: "Finish leased companion work",
    input: completeCompanionImageProcessingInput,
    output: completeCompanionImageProcessingOutput,
    invalidates: ["image", "product"],
  }),
  release: mutation({
    mcp: { omit: "device_protocol" },
    native: "Release interrupted companion work",
    input: releaseCompanionImageProcessingInput,
    output: releaseCompanionImageProcessingOutput,
  }),
  analyses: query({
    mcp: { omit: "client_view" },
    native: "Image analysis history",
    input: imageAnalysisHistoryInput,
    output: imageAnalysisHistoryOutput,
    cache: { tags: [["image"]] },
  }),
  retry: mutation({
    mcp: {
      omit: "operator_maintenance",
      note: "Agents re-run processing through image.schedule_processing",
    },
    native: "Retry failed image processing",
    input: retryImageProcessingInput,
    output: retryImageProcessingOutput,
    invalidates: ["image"],
  }),
  // WebSockets do not have an OpenAPI operation of their own. This native-only
  // validation operation makes the exact shared wire unions generator-visible
  // without inventing a second set of Swift DTOs or carrying binary data over
  // an HTTP fallback.
  validateCompanionMessage: mutation({
    mcp: { omit: "device_protocol" },
    native: "Image processing companion protocol",
    input: validateImageProcessingCompanionMessageInput,
    output: validateImageProcessingCompanionMessageOutput,
  }),
  status: query({
    native: "Image processing status",
    input: imageProcessingStatusInput,
    output: imageProcessingStatusOutput,
    cache: { tags: [["image"]] },
  }),
  schedule: mutation({
    native: "Schedule image processing",
    input: scheduleImageProcessingInput,
    output: scheduleImageProcessingOutput,
    invalidates: ["image"],
  }),
  evaluateAppleDescription: mutation({
    mcp: { omit: "device_protocol" },
    native: "Evaluate image description on Apple device",
    input: evaluateAppleImageDescriptionInput,
    output: evaluateAppleImageDescriptionOutput,
    invalidates: ["image"],
  }),
  correctDescription: mutation({
    native: "Confirm image description correction",
    input: imageDescriptionCorrectionInput,
    output: imageDescriptionCorrectionOutput,
    invalidates: ["image"],
  }),
});
