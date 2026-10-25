import { ImageStatus, imageProcessingIssue } from "@cubby/schemas/image";
import {
  imageCutoutEligibility,
  imageProcessingJobKind,
  imageProcessingJobState,
} from "@cubby/schemas/image-processing";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { image } from "~/server/db/schema";

import { imageJobDisplayStateSql } from "./image-job-state";
import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "./image-processing";

/** The same expression drives Problems membership, list filtering and row labels. */
export function imageProcessingIssueExpression(
  source: typeof image = image,
): SQL<"failed" | "review_needed" | null> {
  const current = sql`j."imageId" = ${source.id} AND j."sourceContentHash" = ${source.sha256}
    AND ((j.kind = ${imageProcessingJobKind.enum.describe_image} AND j."processorRevision" IN (${IMAGE_DESCRIPTION_PROCESSOR_REVISION}, ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}))
      OR (j.kind = ${imageProcessingJobKind.enum.identify_image} AND j."processorRevision" = ${IMAGE_IDENTIFICATION_PROCESSOR_REVISION})
      OR (j.kind = ${imageProcessingJobKind.enum.subject_lift} AND j."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION}))`;
  return sql`CASE WHEN ${source.status} <> ${ImageStatus.enum.UPLOADED} OR ${source.deletedAt} IS NOT NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."deletedAt" IS NULL AND ${current} AND ${imageJobDisplayStateSql({ id: sql`j.id`, state: sql`j.state` })} = ${imageProcessingJobState.enum.failed}) THEN ${imageProcessingIssue.enum.failed}
    WHEN EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."deletedAt" IS NULL AND ${current} AND j.kind = ${imageProcessingJobKind.enum.describe_image}
      AND j.state = ${imageProcessingJobState.enum.ready} AND j.result->'description'->>'cutoutEligibility' = ${imageCutoutEligibility.enum.review})
      AND NOT EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."deletedAt" IS NULL AND ${current} AND j.kind = ${imageProcessingJobKind.enum.subject_lift}
        AND j.state IN (${imageProcessingJobState.enum.ready}, ${imageProcessingJobState.enum.skipped})) THEN ${imageProcessingIssue.enum.review_needed}
    ELSE NULL END`;
}

export async function loadImageProcessingIssues(
  db: Database,
  shortcodes: readonly string[],
) {
  if (!shortcodes.length)
    return new Map<string, "failed" | "review_needed" | null>();
  const rows = await getDb(db)
    .select({
      shortcode: image.shortcode,
      issue: imageProcessingIssueExpression(),
    })
    .from(image)
    .where(
      and(
        inArray(image.shortcode, [...shortcodes]),
        eq(image.status, "UPLOADED"),
      ),
    );
  return new Map(rows.map((row) => [row.shortcode, row.issue]));
}
