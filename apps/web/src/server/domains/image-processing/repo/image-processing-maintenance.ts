import { ImageStatus } from "@cubby/schemas/image";
import {
  imageCutoutEligibility,
  imageProcessingAttemptState,
  imageProcessingJobKind,
  imageProcessingJobState,
  type ImageProcessingJobKind,
} from "@cubby/schemas/image-processing";

const JOB = imageProcessingJobState.enum;
import {
  imageProcessingSettings,
  imageProcessingMaintenanceCounts,
} from "@cubby/schemas/maintenance";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, unwrapDb, withTransaction } from "~/server/db/helpers";
import { appSettings } from "~/server/db/schema";

import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "./image-processing";

// A namespaced settings row, not an import session or a processing run.
const SETTINGS_ID = "00000000-0000-4000-8000-000000000071";
const DEFAULTS = { enabled: false, paused: true };

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

export async function readImageProcessingSettings(
  db: Database | DrizzleTransaction,
  options?: { lock?: boolean },
) {
  const query = unwrapDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  const rows = options?.lock ? await query.for("update") : await query;
  const row = rows[0];
  return row?.metadata ? imageProcessingSettings.parse(row.metadata) : DEFAULTS;
}

/**
 * Serialize a lease against pause/resume updates. Creating the default row in
 * the same transaction gives even a fresh installation a concrete row lock.
 */
export async function mayClaimImageProcessingJob(
  tx: DrizzleTransaction,
): Promise<boolean> {
  await tx
    .insert(appSettings)
    .values({ id: SETTINGS_ID, metadata: DEFAULTS })
    .onConflictDoNothing();
  return !(await readImageProcessingSettings(tx, { lock: true })).paused;
}

export async function writeImageProcessingSettings(
  db: Database,
  settings: z.infer<typeof imageProcessingSettings>,
) {
  await withTransaction(db, async (tx) => {
    await tx
      .insert(appSettings)
      .values({ id: SETTINGS_ID, metadata: DEFAULTS })
      .onConflictDoNothing();
    await tx
      .select({ id: appSettings.id })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ID))
      .for("update");
    await tx
      .update(appSettings)
      .set({ metadata: settings })
      .where(eq(appSettings.id, SETTINGS_ID));
  });
}

export async function imageProcessingMaintenanceSummary(db: Database) {
  const settings = await readImageProcessingSettings(db);
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
  return { settings, description, cutout };
}

/** Shortcodes of uploaded images missing a current job of one of `kinds`. */
export async function imagesMissingCurrentProcessing(
  db: Database,
  kinds: readonly ImageProcessingJobKind[],
  batchSize: number,
): Promise<string[]> {
  // A batch contains only images missing a current job of a requested kind.
  // Existing failed/skipped work is not silently reclassified or retried.
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
  const result = await getDb(db).execute(sql`
    SELECT i.shortcode FROM "Image" i
    WHERE i."deletedAt" IS NULL AND i.status = ${ImageStatus.enum.UPLOADED}
      AND i.sha256 IS NOT NULL AND i."contentType" LIKE 'image/%'
      AND (${sql.join(missing, sql` OR `)})
    ORDER BY i."createdAt", i.id LIMIT ${batchSize}
  `);
  return z
    .array(z.object({ shortcode: z.string() }))
    .parse(result.rows)
    .map((row) => row.shortcode);
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
