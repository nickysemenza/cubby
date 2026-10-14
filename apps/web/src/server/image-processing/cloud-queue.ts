import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";

import { getImageCloudQueue, isCloudflareRuntime } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  readImageCloudQueueRoute,
  readImageProcessingQueuedAt,
} from "~/server/repo/image-processing-routing";

import {
  dispatchImageProcessingWakeup,
  type CloudImageDispatchOptions,
} from "./dispatch";

const log = createLogger("image-cloud-queue");

/** Queue acceptance is awaited before acknowledging the shared wakeup; the job stays unclaimed. */
export async function handoffCloudImageTask(
  db: Database,
  task: Extract<
    BackgroundTask,
    { kind: "image-processing.wakeup" | "image-processing.result" }
  >,
) {
  const requestedAt =
    task.kind === "image-processing.wakeup"
      ? (await readImageCloudQueueRoute(db, task.jobId))?.requestedAt
      : task.result.outcome.status === "normalized"
        ? await readImageProcessingQueuedAt(db, task.result.jobId)
        : null;
  if (!requestedAt) return false;
  const queue = getImageCloudQueue();
  if (!queue) {
    if (isCloudflareRuntime())
      throw new Error("IMAGE_CLOUD_QUEUE binding is not configured");
    return false;
  }
  await queue.sendBatch([
    {
      body: backgroundTaskMessageSchema.parse({
        version: 2,
        queueType: "background",
        task: { ...task, requestedAt },
      }),
    },
  ]);
  return true;
}

/** Only the bounded photo queue may start cloud work in the Worker adapter. */
export async function handleCloudImageTask(
  db: Database,
  task: BackgroundTask,
  options: CloudImageDispatchOptions = {},
): Promise<"succeeded" | "skipped"> {
  const started = performance.now();
  const intentAgeMs = Math.max(0, Date.now() - Date.parse(task.requestedAt));
  let result;
  if (task.kind === "image-processing.wakeup")
    result = await dispatchImageProcessingWakeup(db, task.jobId, options);
  else if (
    task.kind === "image-processing.result" &&
    task.result.outcome.status === "normalized"
  ) {
    const { completeCompanionImageProcessingResult } =
      await import("~/server/services/image-processing.service");
    result = (await completeCompanionImageProcessingResult(db, task.result))
      .adopted
      ? "completed"
      : "skipped";
  } else throw new Error(`Unexpected cloud image task: ${task.kind}`);
  log.info(
    `cloud queue=cubby-image-cloud outcome=${result} intent_age_ms=${intentAgeMs} execution_ms=${Math.round(performance.now() - started)}`,
  );
  return result === "skipped" ? "skipped" : "succeeded";
}
