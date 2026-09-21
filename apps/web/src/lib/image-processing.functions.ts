import { imageProcessingContract } from "~/contracts/image-processing.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const imageProcessing = defineOperationDomain(imageProcessingContract, {
  evaluateAppleDescription: { invalidates: ripple.image },
  analyses: { tags: [["image"]] },
  retry: { invalidates: ripple.image },
  status: { tags: [["image"]] },
  schedule: { invalidates: ripple.image },
  correctDescription: { invalidates: ripple.image },
});
