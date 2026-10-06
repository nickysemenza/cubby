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
    mcp: { omit: "device_protocol", note: "Apple app launch hook" },
    input: z.undefined(),
    output: z.object({ status: z.enum(["queued", "recent"]) }),
    native: "Request background maintenance when the Apple app opens",
  }),
  backfillImageProcessing: mutation({
    mcp: { omit: "operator_maintenance" },
    input: imageProcessingBatchInput,
    output: imageProcessingBatchOutput,
    invalidates: ["maintenance"],
  }),
  imageProcessing: query({
    mcp: { omit: "operator_maintenance" },
    input: z.undefined(),
    output: imageProcessingMaintenanceOutput,
    cache: { tags: [["maintenance"], ["image"]] },
  }),
  configureImageProcessing: mutation({
    mcp: { omit: "operator_maintenance" },
    input: imageProcessingSettings,
    output: imageProcessingSettings,
    invalidates: ["maintenance"],
  }),
  // Live operational state.
  awaitingWork: query({
    mcp: { omit: "operator_maintenance" },
    readPolicy: "strong",
    input: z.undefined(),
    output: awaitingWorkSchema,
  }),
  settleAwaitingWork: mutation({
    mcp: { omit: "operator_maintenance" },
    input: z.undefined(),
    output: settleAwaitingWorkOutSchema,
    invalidates: ["maintenance"],
  }),
  repairImageDimensions: mutation({
    mcp: { omit: "operator_maintenance" },
    input: repairImageDimensionsInputSchema,
    output: repairImageDimensionsOutSchema,
    invalidates: ["maintenance"],
  }),
  classifyImageProvenance: mutation({
    mcp: { omit: "operator_maintenance" },
    input: classifyImageProvenanceInputSchema,
    output: classifyImageProvenanceOutSchema,
    invalidates: ["image"],
  }),
  backfillImageMetadata: mutation({
    mcp: { omit: "operator_maintenance" },
    input: backfillImageMetadataInputSchema,
    output: backfillImageMetadataOutSchema,
    invalidates: ["image"],
  }),
  backfillImageSearch: mutation({
    mcp: { omit: "operator_maintenance" },
    input: backfillImageSearchInputSchema,
    output: backfillImageSearchOutSchema,
    invalidates: ["maintenance"],
  }),
});
