import {
  imageAnalysisHistoryInput,
  imageAnalysisHistoryOutput,
  retryImageProcessingInput,
  retryImageProcessingOutput,
} from "@cubby/schemas/activity";
import {
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
  analyses: query({
    native: "Image analysis history",
    input: imageAnalysisHistoryInput,
    output: imageAnalysisHistoryOutput,
  }),
  retry: mutation({
    native: "Retry failed image processing",
    input: retryImageProcessingInput,
    output: retryImageProcessingOutput,
  }),
  // WebSockets do not have an OpenAPI operation of their own. This native-only
  // validation operation makes the exact shared wire unions generator-visible
  // without inventing a second set of Swift DTOs or carrying binary data over
  // an HTTP fallback.
  validateCompanionMessage: mutation({
    native: "Image processing companion protocol",
    input: validateImageProcessingCompanionMessageInput,
    output: validateImageProcessingCompanionMessageOutput,
  }),
  status: query({
    native: "Image processing status",
    input: imageProcessingStatusInput,
    output: imageProcessingStatusOutput,
  }),
  schedule: mutation({
    native: "Schedule image processing",
    input: scheduleImageProcessingInput,
    output: scheduleImageProcessingOutput,
  }),
  evaluateAppleDescription: mutation({
    native: "Evaluate image description on Apple device",
    input: evaluateAppleImageDescriptionInput,
    output: evaluateAppleImageDescriptionOutput,
  }),
  correctDescription: mutation({
    native: "Confirm image description correction",
    input: imageDescriptionCorrectionInput,
    output: imageDescriptionCorrectionOutput,
  }),
});
