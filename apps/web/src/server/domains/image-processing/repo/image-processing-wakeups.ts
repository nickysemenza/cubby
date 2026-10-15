/** Background wakeups for image-processing jobs; paused processing publishes none. */
import type { Database } from "~/server/db";
import { readImageProcessingSettings } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

const IMAGE_PROCESSING_WAKEUP_SOURCE = "image-processing";

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
