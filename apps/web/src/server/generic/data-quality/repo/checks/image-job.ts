import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { imageProcessingJob } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const IMAGE_JOB_QUALITY_RULES_VERSION = 1;

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

async function loadImageJobQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: imageProcessingJob.id,
      shortcode: imageProcessingJob.shortcode,
      state: imageProcessingJob.state,
      lastError: imageProcessingJob.lastError,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("imageJob", sql`${imageProcessingJob.id}`)}`,
    })
    .from(imageProcessingJob)
    .where(
      and(
        notDeleted(imageProcessingJob),
        sql`${imageProcessingJob.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
