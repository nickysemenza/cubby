import {
  imageProcessingSettings,
  imageProcessingMaintenanceCounts,
} from "@cubby/schemas/maintenance";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { appSettings } from "~/server/db/schema";
import {
  getDb,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";

import {
  reclaimExpiredImageProcessingLeases,
  findImageProcessingDispatchRepairs,
  retryFailedImageProcessingJobs,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "./image-processing";

// A namespaced settings row, not an import session or a processing run.
const SETTINGS_ID = "00000000-0000-4000-8000-000000000071";
const DEFAULTS = { enabled: false, paused: true };

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

export async function updateImageProcessingSettings(
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
  if (!settings.paused) {
    const { publishImageProcessingWakeups } =
      await import("~/server/services/image-processing.service");
    await reclaimExpiredImageProcessingLeases(db);
    await publishImageProcessingWakeups(
      db,
      await findImageProcessingDispatchRepairs(db, 100),
    );
  }
  return settings;
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
        LEFT JOIN "ImageProcessingJob" j ON j."imageId" = i.id
          AND j.kind = ${kind} AND j."sourceContentHash" = i.sha256 AND j."processorRevision" = ${revision}
        WHERE i."deletedAt" IS NULL AND i.status = 'UPLOADED' AND i.sha256 IS NOT NULL
          AND i."contentType" LIKE 'image/%'
      )
      SELECT count(*) FILTER (WHERE state = 'ready')::int AS current,
        count(*) FILTER (WHERE state IN ('pending', 'leased'))::int AS pending,
        count(*) FILTER (WHERE state = 'waiting_for_device')::int AS waiting,
        count(*) FILTER (WHERE state = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        count(*) FILTER (WHERE result->'description'->>'cutoutEligibility' = 'review')::int AS "reviewNeeded",
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

export async function backfillImageProcessing(
  db: Database,
  input: { batchSize: number; retryFailures: boolean },
) {
  const { scheduleImageProcessingJobs, publishImageProcessingWakeups } =
    await import("~/server/services/image-processing.service");
  const settings = await readImageProcessingSettings(db);
  if (settings.paused) return { scheduled: 0, paused: true };
  if (input.retryFailures) {
    const jobs = await retryFailedImageProcessingJobs(db, input.batchSize);
    await publishImageProcessingWakeups(db, jobs);
    return { scheduled: jobs.length, paused: false };
  }
  // A batch contains only images missing a current description or cutout decision.
  // Existing failed/skipped work is not silently reclassified or retried.
  const result = await getDb(db).execute(sql`
    SELECT i.shortcode FROM "Image" i
    WHERE i."deletedAt" IS NULL AND i.status = 'UPLOADED'
      AND i.sha256 IS NOT NULL AND i."contentType" LIKE 'image/%'
      AND (NOT EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."imageId" = i.id
          AND j.kind = 'describe_image' AND j."sourceContentHash" = i.sha256 AND j."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION})
        OR NOT EXISTS (SELECT 1 FROM "ImageProcessingJob" j WHERE j."imageId" = i.id
          AND j.kind = 'subject_lift' AND j."sourceContentHash" = i.sha256 AND j."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION}))
    ORDER BY i."createdAt", i.id LIMIT ${input.batchSize}
  `);
  const rows = z.array(z.object({ shortcode: z.string() })).parse(result.rows);
  const jobs: string[] = [];
  for (const row of rows) {
    const scheduled = await scheduleImageProcessingJobs(db, {
      id: row.shortcode,
      kinds: ["describe_image", "subject_lift"],
      publish: false,
    });
    jobs.push(...scheduled.jobIds);
  }
  await publishImageProcessingWakeups(db, jobs);
  return { scheduled: rows.length, paused: false };
}

export async function repairImageProcessingWork(db: Database) {
  const {
    cleanupExpiredImageProcessingOrphans,
    publishImageProcessingWakeups,
  } = await import("~/server/services/image-processing.service");
  await cleanupExpiredImageProcessingOrphans(db, 100);
  if ((await readImageProcessingSettings(db)).paused) return;
  await reclaimExpiredImageProcessingLeases(db);
  await publishImageProcessingWakeups(
    db,
    await findImageProcessingDispatchRepairs(db, 100),
  );
}
