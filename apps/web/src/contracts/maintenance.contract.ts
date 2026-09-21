import {
  imageProcessingMaintenanceOutput,
  imageProcessingBatchInput,
  imageProcessingBatchOutput,
  imageProcessingSettings,
  awaitingWorkSchema,
  settleAwaitingWorkOutSchema,
  repairImageDimensionsInputSchema,
  repairImageDimensionsOutSchema,
} from "@cubby/schemas/maintenance";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * Derived work waiting on a queue wakeup, read from the source rows' own
 * staleness markers, and the one action that republishes it. There is no
 * run history: the counts are the truth, and they shrink as the queue lands.
 */
export const maintenanceContract = defineContract("maintenance", {
  backfillImageProcessing: mutation({
    input: imageProcessingBatchInput,
    output: imageProcessingBatchOutput,
  }),
  imageProcessing: query({
    input: z.undefined(),
    output: imageProcessingMaintenanceOutput,
  }),
  configureImageProcessing: mutation({
    input: imageProcessingSettings,
    output: imageProcessingSettings,
  }),
  awaitingWork: query({
    input: z.undefined(),
    output: awaitingWorkSchema,
  }),
  settleAwaitingWork: mutation({
    input: z.undefined(),
    output: settleAwaitingWorkOutSchema,
  }),
  repairImageDimensions: mutation({
    input: repairImageDimensionsInputSchema,
    output: repairImageDimensionsOutSchema,
  }),
});
