import {
  maintenanceRunOutSchema,
  maintenanceStatusSchema,
  repairImageDimensionsInputSchema,
  repairImageDimensionsOutSchema,
  classifyImageProvenanceInputSchema,
  classifyImageProvenanceOutSchema,
  backfillImageSearchInputSchema,
  backfillImageSearchOutSchema,
} from "@cubby/schemas/maintenance";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * Maintenance passes are `maintenance` Runs: the nightly cron and "Run now"
 * launch one (one active at a time), and its steps keep the history of what
 * each backlog found, did and failed. The backlog counts are read from the
 * source rows' own staleness markers.
 */
export const maintenanceContract = defineContract("maintenance", {
  requestCatchUp: mutation({
    mcp: { omit: "device_protocol", note: "Apple app launch hook" },
    input: z.undefined(),
    output: z.object({ status: z.enum(["queued", "recent"]) }),
    native: "Request background maintenance when the Apple app opens",
  }),
  run: mutation({
    mcp: { omit: "operator_maintenance" },
    input: z.undefined(),
    output: maintenanceRunOutSchema,
    invalidates: ["maintenance", "runOnly"],
  }),
  // Live operational state.
  status: query({
    mcp: { omit: "operator_maintenance" },
    readPolicy: "strong",
    input: z.undefined(),
    output: maintenanceStatusSchema,
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
  backfillImageSearch: mutation({
    mcp: { omit: "operator_maintenance" },
    input: backfillImageSearchInputSchema,
    output: backfillImageSearchOutSchema,
    invalidates: ["maintenance"],
  }),
});
