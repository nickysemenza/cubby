import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";

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
  publishImageProcessingWakeups,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";

import {
  cleanupExpiredImageProcessingOrphans,
  scheduleImageProcessingJobs,
} from "./image-processing.service";

export async function backfillImageProcessing(
  db: Database,
  input: {
    batchSize: number;
    retryFailures: boolean;
    kinds?: readonly ImageProcessingJobKind[];
  },
) {
  const kinds = input.kinds ?? ALL_IMAGE_PROCESSING_KINDS;
  if (input.retryFailures) {
    const submission = await createImageProcessingSubmission(db);
    const jobs = await retryFailedImageProcessingJobs(db, input.batchSize, {
      submissionId: submission.id,
      kinds,
    });
    await publishImageProcessingWakeups(db, jobs);
    return {
      scheduled: jobs.length,
      submissionId: submission.publicId,
    };
  }
  const shortcodes = await imagesMissingCurrentProcessing(
    db,
    kinds,
    input.batchSize,
  );
  if (shortcodes.length === 0) return { scheduled: 0 };
  const submission = await createImageProcessingSubmission(db);
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
    submissionId: submission.publicId,
  };
}

export async function repairImageProcessingWork(db: Database) {
  await cleanupExpiredImageProcessingOrphans(db, 100);
  await pruneExecutorlessWaitingAttempts(db, 500);
  await reclaimExpiredImageProcessingLeases(db);
  await publishImageProcessingWakeups(
    db,
    await findImageProcessingDispatchRepairs(db, 100),
  );
  await backfillImageProcessing(db, { batchSize: 25, retryFailures: false });
}
