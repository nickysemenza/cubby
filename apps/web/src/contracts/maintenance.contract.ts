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
export const maintenanceContract = defineContract(
  "maintenance",
  {
    requestCatchUp: mutation({
      exposure: "internal",
      note: "Apple app launch hook",
      input: z.undefined(),
      output: z.object({ status: z.enum(["queued", "recent"]) }),
      native: "Request background maintenance when the Apple app opens",
    }),
    run: mutation({
      description:
        "Start the named maintenance operation. It may update derived or support records; inspect maintenance.status for progress and outcome.",
      input: z.undefined(),
      output: maintenanceRunOutSchema,
      invalidates: ["maintenance", "runOnly"],
    }),
    // Live operational state.
    status: query({
      description:
        "Read the status and latest result of a maintenance operation. This does not start or retry it.",
      readPolicy: "strong",
      input: z.undefined(),
      output: maintenanceStatusSchema,
    }),
    repairImageDimensions: mutation({
      description:
        "Repair missing or invalid dimensions on retained image records. This updates derived metadata and leaves the image bytes unchanged.",
      input: repairImageDimensionsInputSchema,
      output: repairImageDimensionsOutSchema,
      invalidates: ["maintenance"],
    }),
    classifyImageProvenance: mutation({
      description:
        "Classify retained image provenance from its stored evidence. This updates image metadata; inspect the result before using it for a household decision.",
      input: classifyImageProvenanceInputSchema,
      output: classifyImageProvenanceOutSchema,
      invalidates: ["image"],
    }),
    backfillImageSearch: mutation({
      description:
        "Backfill image search records from retained images. This changes derived search data; use search.debug to inspect index coverage afterward.",
      input: backfillImageSearchInputSchema,
      output: backfillImageSearchOutSchema,
      invalidates: ["maintenance"],
    }),
  },
  { exposure: "capability" },
);
