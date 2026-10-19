import type { RunId } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";

import type { Database } from "~/server/db";
import {
  findImageProcessingDispatchRepairs,
  reclaimExpiredImageProcessingLeases,
} from "~/server/domains/image-processing/repo/image-processing";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import {
  ALL_IMAGE_PROCESSING_KINDS,
  imagesMissingCurrentProcessing,
  pruneExecutorlessWaitingAttempts,
  publishImageProcessingWakeups,
  type ImageProcessingBacklogCursor,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";

import {
  cleanupExpiredImageProcessingOrphans,
  scheduleImageProcessingJobs,
} from "./image-processing.service";

/**
 * Schedules one keyset page of images missing a current job. `publish: false`
 * leaves the wakeups to a caller that dispatches the jobs itself.
 */
export async function backfillImageProcessing(
  db: Database,
  input: {
    batchSize: number;
    kinds?: readonly ImageProcessingJobKind[];
    after?: ImageProcessingBacklogCursor | null;
    runId?: RunId;
    publish?: boolean;
  },
) {
  const kinds = input.kinds ?? ALL_IMAGE_PROCESSING_KINDS;
  const images = await imagesMissingCurrentProcessing(
    db,
    kinds,
    input.batchSize,
    input.after,
  );
  if (images.length === 0) return { scheduled: 0, images: [] };
  const submission = await createImageProcessingSubmission(db);
  const scheduled = [];
  for (const candidate of images) {
    const jobs = await scheduleImageProcessingJobs(db, {
      id: candidate.shortcode,
      kinds,
      publish: false,
      submission,
      runId: input.runId ?? null,
    });
    scheduled.push({ ...candidate, jobIds: jobs.jobIds });
  }
  if (input.publish !== false)
    await publishImageProcessingWakeups(
      db,
      scheduled.flatMap((candidate) => candidate.jobIds),
    );
  return {
    scheduled: images.length,
    submissionId: submission.publicId,
    images: scheduled,
  };
}

/** Bounded repairs of orphans, executorless attempts, leases and lost wakeups. */
export async function repairImageProcessingWork(db: Database) {
  const orphans = await cleanupExpiredImageProcessingOrphans(db, 100);
  const executorless = await pruneExecutorlessWaitingAttempts(db, 500);
  const leases = await reclaimExpiredImageProcessingLeases(db);
  const dispatch = await findImageProcessingDispatchRepairs(db, 100);
  await publishImageProcessingWakeups(db, dispatch);
  return {
    orphans,
    executorless,
    leases,
    dispatch: dispatch.length,
    // Only deletions shrink their own selection; republished wakeups leave
    // their jobs selectable until the queue lands them.
    more: orphans >= 100 || executorless >= 500,
  };
}
