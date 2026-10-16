import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";
import type { imageProcessingSettings } from "@cubby/schemas/maintenance";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  findImageProcessingDispatchRepairs,
  reclaimExpiredImageProcessingLeases,
  retryFailedImageProcessingJobs,
} from "~/server/domains/image-processing/repo/image-processing";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import {
  ALL_IMAGE_PROCESSING_KINDS,
  imagesMissingCurrentProcessing,
  pruneExecutorlessWaitingAttempts,
  readImageProcessingSettings,
  writeImageProcessingSettings,
  publishImageProcessingWakeups,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";

import {
  cleanupExpiredImageProcessingOrphans,
  scheduleImageProcessingJobs,
} from "./image-processing.service";

/** Save pause/resume; resuming reclaims expired leases and re-wakes repairable jobs. */
export async function updateImageProcessingSettings(
  db: Database,
  settings: z.infer<typeof imageProcessingSettings>,
) {
  await writeImageProcessingSettings(db, settings);
  if (!settings.paused) {
    await reclaimExpiredImageProcessingLeases(db);
    await publishImageProcessingWakeups(
      db,
      await findImageProcessingDispatchRepairs(db, 100),
    );
  }
  return settings;
}

export async function backfillImageProcessing(
  db: Database,
  input: {
    batchSize: number;
    retryFailures: boolean;
    kinds?: readonly ImageProcessingJobKind[];
  },
) {
  const kinds = input.kinds ?? ALL_IMAGE_PROCESSING_KINDS;
  const settings = await readImageProcessingSettings(db);
  if (settings.paused) return { scheduled: 0, paused: true };
  const submission = await createImageProcessingSubmission(db);
  if (input.retryFailures) {
    const jobs = await retryFailedImageProcessingJobs(db, input.batchSize, {
      submissionId: submission.id,
      kinds,
    });
    await publishImageProcessingWakeups(db, jobs);
    return {
      scheduled: jobs.length,
      paused: false,
      submissionId: submission.publicId,
    };
  }
  const shortcodes = await imagesMissingCurrentProcessing(
    db,
    kinds,
    input.batchSize,
  );
  const jobs: string[] = [];
  for (const shortcode of shortcodes) {
    const scheduled = await scheduleImageProcessingJobs(db, {
      id: shortcode,
      kinds,
      publish: false,
      submission,
    });
    jobs.push(...scheduled.jobIds);
  }
  await publishImageProcessingWakeups(db, jobs);
  return {
    scheduled: shortcodes.length,
    paused: false,
    submissionId: submission.publicId,
  };
}

export async function repairImageProcessingWork(db: Database) {
  await cleanupExpiredImageProcessingOrphans(db, 100);
  await pruneExecutorlessWaitingAttempts(db, 500);
  if ((await readImageProcessingSettings(db)).paused) return;
  await reclaimExpiredImageProcessingLeases(db);
  await publishImageProcessingWakeups(
    db,
    await findImageProcessingDispatchRepairs(db, 100),
  );
}
