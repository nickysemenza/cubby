import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { sql } from "drizzle-orm";

import { imageProcessingJob } from "~/server/db/retained-tables";

import { defineEntityChecks } from "../registry";

type ImageJob = typeof imageProcessingJob;

// Waiting or leased work is operational state, not a gap in the record, so
// only settled outcomes are checked.
export const imageJobChecks = defineEntityChecks({
  entity: "imageJob",
  table: imageProcessingJob,
  checks: {
    image_job_failed: {
      missing: (t: ImageJob) =>
        sql`${t.state} = ${imageProcessingJobState.enum.failed}`,
    },
    image_job_unexplained_skip: {
      missing: (t: ImageJob) =>
        sql`${t.state} = ${imageProcessingJobState.enum.skipped} AND ${t.lastError} IS NULL`,
    },
  },
});
