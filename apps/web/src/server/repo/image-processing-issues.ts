import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { image } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "./image-processing";

/** The same expression drives Problems membership, list filtering and row labels. */
function imageProcessingIssueExpression(
  source: typeof image = image,
): SQL<"failed" | "review_needed" | null> {
  const current = sql`j."imageId" = ${source.id} AND j."sourceContentHash" = ${source.sha256}
    AND ((j.kind = 'describe_image' AND j."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION})
      OR (j.kind = 'subject_lift' AND j."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION}))`;
  return sql`CASE WHEN ${source.status} <> 'UPLOADED' OR ${source.deletedAt} IS NOT NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE ${current} AND j.state = 'failed') THEN 'failed'
    WHEN EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE ${current} AND j.kind = 'describe_image'
      AND j.state = 'ready' AND j.result->'description'->>'cutoutEligibility' = 'review') THEN 'review_needed'
    ELSE NULL END`;
}

export function imageProcessingIssueFilter(
  source: typeof image,
  requested: string | readonly string[] | undefined,
): SQL | undefined {
  if (!requested) return undefined;
  const values = z
    .array(z.string())
    .parse(Array.isArray(requested) ? requested : [requested]);
  return values.length
    ? inArray(imageProcessingIssueExpression(source), values)
    : undefined;
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
