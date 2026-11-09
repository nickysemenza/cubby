import { imageProcessingJobState } from "@cubby/schemas/image-processing";

import { imageProcessingJob } from "~/server/db/retained-tables";
import { imageJobActionStateSql } from "~/server/domains/image-processing/repo/image-job-state";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadImageJobQualityRecords = qualityCheck.records(
  "imageJob",
  imageProcessingJob,
  {
    state: imageJobActionStateSql(),
    lastError: imageProcessingJob.lastError,
  },
);

/** Bump when the rules or their declared scoring metadata change. */
const IMAGE_JOB_QUALITY_RULES_VERSION = 2;

type ImageJobQualityRecord = Awaited<
  ReturnType<typeof loadImageJobQualityRecords>
>[number];

export const imageJobChecks = defineStoredEntityChecks({
  entity: "imageJob",
  table: imageProcessingJob,
  rulesVersion: IMAGE_JOB_QUALITY_RULES_VERSION,
  load: loadImageJobQualityRecords,
  checks: {
    imagejob_display_image: qualityCheck.hasImage,
    // Waiting or leased work is operational state, not a quality gap.
    image_job_failed: qualityCheck.observed<ImageJobQualityRecord>(
      (record) => record.state !== imageProcessingJobState.enum.failed,
    ),
    image_job_unexplained_skip: qualityCheck.observed<ImageJobQualityRecord>(
      (record) =>
        record.state !== imageProcessingJobState.enum.skipped ||
        record.lastError !== null,
    ),
  },
});
