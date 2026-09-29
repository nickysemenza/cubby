import {
  imageProcessingMaintenanceOutput,
  imageProcessingBatchInput,
  imageProcessingBatchOutput,
  imageProcessingSettings,
  awaitingWorkSchema,
  settleAwaitingWorkOutSchema,
  repairImageDimensionsInputSchema,
  repairImageDimensionsOutSchema,
  classifyImageProvenanceInputSchema,
  classifyImageProvenanceOutSchema,
  backfillImageMetadataInputSchema,
  backfillImageMetadataOutSchema,
  backfillImageSearchInputSchema,
  backfillImageSearchOutSchema,
} from "@cubby/schemas/maintenance";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * Derived work waiting on a queue wakeup, read from the source rows' own
 * staleness markers, and the one action that republishes it. There is no
 * run history: the counts are the truth, and they shrink as the queue lands.
 */
export const maintenanceContract = defineContract("maintenance", {
  requestCatchUp: mutation({
    input: z.undefined(),
    output: z.object({ status: z.enum(["queued", "recent"]) }),
    native: "Request background maintenance when the Apple app opens",
  }),
  backfillImageProcessing: mutation({
    input: imageProcessingBatchInput,
    output: imageProcessingBatchOutput,
    invalidates: ["maintenance"],
  }),
  imageProcessing: query({
    input: z.undefined(),
    output: imageProcessingMaintenanceOutput,
    cache: { tags: [["maintenance"], ["image"]] },
  }),
  configureImageProcessing: mutation({
    input: imageProcessingSettings,
    output: imageProcessingSettings,
    invalidates: ["maintenance"],
  }),
  // Live operational state.
  awaitingWork: query({
    readPolicy: "strong",
    input: z.undefined(),
    output: awaitingWorkSchema,
  }),
  settleAwaitingWork: mutation({
    input: z.undefined(),
    output: settleAwaitingWorkOutSchema,
    invalidates: ["maintenance"],
  }),
  repairImageDimensions: mutation({
    input: repairImageDimensionsInputSchema,
    output: repairImageDimensionsOutSchema,
    invalidates: ["maintenance"],
  }),
  classifyImageProvenance: mutation({
    input: classifyImageProvenanceInputSchema,
    output: classifyImageProvenanceOutSchema,
    invalidates: ["image"],
  }),
  backfillImageMetadata: mutation({
    input: backfillImageMetadataInputSchema,
    output: backfillImageMetadataOutSchema,
    invalidates: ["image"],
  }),
  backfillImageSearch: mutation({
    input: backfillImageSearchInputSchema,
    output: backfillImageSearchOutSchema,
    invalidates: ["maintenance"],
  }),
});
