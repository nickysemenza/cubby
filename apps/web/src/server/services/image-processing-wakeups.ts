import type { RunId } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import {
  claimImageProcessingOrphans,
  finalizeImageProcessingOrphans,
} from "~/server/repo/image-processing";
import { readImageProcessingSettings } from "~/server/repo/image-processing-settings";
import { persistImageProcessingSubmission } from "~/server/repo/image-processing-submission";
import { deleteS3Object } from "~/server/utils/s3";

const IMAGE_PROCESSING_WAKEUP_SOURCE = "image-processing";

/**
 * Persist both jobs before publishing their lightweight wakeups. The caller
 * never waits for a companion: durable rows repair a missed publication.
 */
export async function scheduleImageProcessingJobs(
  db: Database,
  input: {
    id: string;
    kinds: readonly ImageProcessingJobKind[];
    publish?: boolean;
    automatic?: boolean;
    submission?: { id: string; publicId: string };
    /** The Run that requested this scheduling, when the caller has one. */
    runId?: RunId | null;
  },
): Promise<{ jobIds: string[]; submissionId?: string }> {
  const settings = await readImageProcessingSettings(db);
  if (input.automatic && !settings.enabled) return { jobIds: [] };
  const scheduled = await persistImageProcessingSubmission(db, input);
  if (input.publish !== false && !settings.paused)
    await publishImageProcessingWakeups(db, scheduled.jobIds);
  return scheduled;
}

/** Queue payloads only wake durable rows, so repeats and repairs are harmless. */
export async function publishImageProcessingWakeups(
  db: Database,
  jobIds: readonly string[],
): Promise<void> {
  const settings = await readImageProcessingSettings(db);
  if (settings.paused || jobIds.length === 0) return;
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

/** Remove only orphan outputs whose signed upload window has elapsed. */
export async function cleanupExpiredImageProcessingOrphans(
  db: Database,
  limit: number,
): Promise<number> {
  const keys = await claimImageProcessingOrphans(db, limit);
  await Promise.all(keys.map((key) => deleteS3Object(key)));
  await finalizeImageProcessingOrphans(db, keys);
  return keys.length;
}
