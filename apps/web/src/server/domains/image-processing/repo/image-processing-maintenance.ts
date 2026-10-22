import { ImageStatus } from "@cubby/schemas/image";
import {
  imageCutoutEligibility,
  imageProcessingAttemptState,
  imageProcessingJobKind,
  imageProcessingJobState,
  type ImageProcessingJobKind,
} from "@cubby/schemas/image-processing";

const JOB = imageProcessingJobState.enum;
import { imageProcessingMaintenanceCounts } from "@cubby/schemas/maintenance";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "./image-processing";

export const ALL_IMAGE_PROCESSING_KINDS: readonly ImageProcessingJobKind[] = [
  "describe_image",
  "identify_image",
  "subject_lift",
];
const REVISION_BY_KIND = {
  describe_image: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  identify_image: IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  subject_lift: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} satisfies Record<ImageProcessingJobKind, number>;

export async function imageProcessingMaintenanceSummary(db: Database) {
  const counts = async (
    kind: "describe_image" | "subject_lift",
    revision: number,
  ) => {
    const result = await getDb(db).execute(sql`
      WITH current_images AS (
        SELECT i.id, j.state, j.result
        FROM "Image" i
        LEFT JOIN "ImageProcessingJob" j ON j."imageId" = i.id AND j."deletedAt" IS NULL
          AND j.kind = ${kind} AND j."sourceContentHash" = i.sha256 AND j."processorRevision" = ${revision}
        WHERE i."deletedAt" IS NULL AND i.status = ${ImageStatus.enum.UPLOADED} AND i.sha256 IS NOT NULL
          AND i."contentType" LIKE 'image/%'
      )
      SELECT count(*) FILTER (WHERE state = ${JOB.ready})::int AS current,
        count(*) FILTER (WHERE state IN (${JOB.pending}, ${JOB.leased}))::int AS pending,
        count(*) FILTER (WHERE state = ${JOB.waiting_for_device})::int AS waiting,
        count(*) FILTER (WHERE state = ${JOB.skipped})::int AS skipped,
        count(*) FILTER (WHERE state = ${JOB.failed})::int AS failed,
        count(*) FILTER (WHERE result->'description'->>'cutoutEligibility' = ${imageCutoutEligibility.enum.review})::int AS "reviewNeeded",
        count(*) FILTER (WHERE state IS NULL)::int AS remaining
      FROM current_images
    `);
    return imageProcessingMaintenanceCounts.parse(result.rows[0]);
  };
  const [description, cutout] = await Promise.all([
    counts("describe_image", IMAGE_DESCRIPTION_PROCESSOR_REVISION),
    counts("subject_lift", IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION),
  ]);
  return { description, cutout };
}

export type ImageProcessingBacklogCursor = { createdAt: string; id: string };

// Only images missing a current job of a requested kind. Existing
// failed/skipped work is not silently reclassified or retried.
const missingCurrentProcessingWhere = (
  kinds: readonly ImageProcessingJobKind[],
) => {
  const missing = kinds.map(
    (
      kind,
    ) => sql`NOT EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."imageId" = i.id AND j."deletedAt" IS NULL
          AND j.kind = ${kind} AND j."sourceContentHash" = i.sha256 AND j."processorRevision" = ${REVISION_BY_KIND[kind]})`,
  );
  if (kinds.includes("describe_image"))
    missing.push(sql`NOT EXISTS (
    SELECT 1 FROM "ImageProcessingJob" j WHERE j."imageId" = i.id AND j."deletedAt" IS NULL
      AND j.kind = ${imageProcessingJobKind.enum.describe_image} AND j."sourceContentHash" = i.sha256
      AND j."processorRevision" = ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION})`);
  return sql`i."deletedAt" IS NULL AND i.status = ${ImageStatus.enum.UPLOADED}
      AND i.sha256 IS NOT NULL AND i."contentType" LIKE 'image/%'
      AND (${sql.join(missing, sql` OR `)})`;
};

/** One keyset page of uploaded images missing a current job of one of `kinds`. */
export async function imagesMissingCurrentProcessing(
  db: Database,
  kinds: readonly ImageProcessingJobKind[],
  batchSize: number,
  after?: ImageProcessingBacklogCursor | null,
) {
  const result = await getDb(db).execute(sql`
    SELECT i.id, i.shortcode, i."createdAt"::text AS "createdAt" FROM "Image" i
    WHERE ${missingCurrentProcessingWhere(kinds)}
      ${after ? sql`AND (i."createdAt", i.id) > (${after.createdAt}::timestamp, ${after.id}::uuid)` : sql``}
    ORDER BY i."createdAt", i.id LIMIT ${batchSize}
  `);
  return z
    .array(
      z.object({
        id: z.string(),
        shortcode: z.string(),
        createdAt: z.string(),
      }),
    )
    .parse(result.rows)
    .map(({ id, shortcode, createdAt }) => ({
      id,
      shortcode,
      cursor: { createdAt, id },
    }));
}

/**
 * Delete one bounded batch of attempts that waited without ever having an
 * executor (written by the old dispatcher on every idle cycle), with their
 * claim/waiting events, and reset `attempts` on the touched jobs to the number
 * of attempts that remain. Returns the number of attempts deleted.
 */
export async function pruneExecutorlessWaitingAttempts(
  db: Database,
  limit: number,
): Promise<number> {
  const result = await getDb(db).execute(sql`
    WITH doomed AS (
      SELECT id, "jobId" FROM "ImageProcessingAttempt"
      WHERE state = ${imageProcessingAttemptState.enum.waiting} AND executor IS NULL
      ORDER BY "startedAt", id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), deleted_events AS (
      DELETE FROM "ImageProcessingEvent" e USING doomed d
      WHERE e."jobId" = d."jobId"
        AND e."eventKey" IN (d.id::text || ':claimed', d.id::text || ':waiting')
    ), deleted AS (
      DELETE FROM "ImageProcessingAttempt" a USING doomed d
      WHERE a.id = d.id
      RETURNING a."jobId"
    ), touched AS (
      SELECT DISTINCT "jobId" FROM deleted
    ), fixed AS (
      UPDATE "ImageProcessingJob" j
      SET attempts = (
        SELECT count(*)::int FROM "ImageProcessingAttempt" a
        WHERE a."jobId" = j.id AND a.id NOT IN (SELECT id FROM doomed)
      )
      FROM touched t WHERE j.id = t."jobId"
    )
    SELECT count(*)::int AS pruned FROM deleted`);
  return z.array(z.object({ pruned: z.number() })).parse(result.rows)[0]!
    .pruned;
}

const IMAGE_PROCESSING_WAKEUP_SOURCE = "image-processing";

/** Queue payloads only wake durable rows, so repeats and repairs are harmless. */
export async function publishImageProcessingWakeups(
  db: Database,
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) return;
  await publishBackgroundTasks(
    db,
    [...new Set(jobIds)].map((jobId) => ({
      kind: "image-processing.wakeup" as const,
      requestedAt: new Date().toISOString(),
      jobId,
    })),
    { source: IMAGE_PROCESSING_WAKEUP_SOURCE },
  );
}
