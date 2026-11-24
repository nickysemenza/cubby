import type { RunId } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";

import type { Database } from "~/server/db";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import {
  ALL_IMAGE_PROCESSING_KINDS,
  imagesMissingCurrentProcessing,
  type ImageProcessingBacklogCursor,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";

import {
  cleanupExpiredImageProcessingOrphans,
  scheduleImageProcessingJobs,
} from "./image-processing.service";

/** Schedules one keyset page of images missing a current job. */
export async function backfillImageProcessing(
  db: Database,
  input: {
    batchSize: number;
    kinds?: readonly ImageProcessingJobKind[];
    after?: ImageProcessingBacklogCursor | null;
    runId?: RunId;
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
      submission,
      runId: input.runId ?? null,
    });
    scheduled.push({ ...candidate, jobIds: jobs.jobIds });
  }
  return {
    scheduled: images.length,
    submissionId: submission.publicId,
    images: scheduled,
  };
}

/** Direct bounded cleanup; Job claims recover interrupted execution without scanners. */
export async function repairImageProcessingWork(db: Database) {
  const orphans = await cleanupExpiredImageProcessingOrphans(db, 100);
  return {
    orphans,
    // Only deletions shrink their own selection; republished wakeups leave
    // their jobs selectable until the queue lands them.
    more: orphans >= 100,
  };
}
