import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { drainProductionJobs } from "~/server/workflows/jobs";

import type {
  BackgroundQueueBatch,
  BackgroundQueueDeliveredMessage,
} from "../background-queue-types";

export interface BackgroundQueueConsumerPorts {
  readonly captureException: (error: UnparsedError) => void;
  readonly afterSuccess?: () => Promise<void>;
  readonly handlers?: JobHandlers;
}
export type BackgroundQueueMessageOutcome =
  | "succeeded"
  | "skipped"
  | "unreadable"
  | "failed";

/** Queue delivery retries transport/runtime failures; Job owns execution retries. */
export async function handleBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
  ports: BackgroundQueueConsumerPorts,
  ring: boolean = backgroundTaskMessageSchema.safeParse(message.body).data
    ?.ring ?? false,
): Promise<BackgroundQueueMessageOutcome> {
  const parsed = backgroundTaskMessageSchema.safeParse(message.body);
  try {
    if (ring)
      await (
        await import("~/server/domains/image-processing/repo/image-processing-ring")
      ).ringDueDeviceWork(db);
    if (ports.handlers)
      await (
        await import("~/server/generic/jobs/service/jobs")
      ).drainDueJobs(db, ports.handlers);
    else await drainProductionJobs(db);
    message.ack();
    return parsed.success ? "succeeded" : "unreadable";
  } catch (error) {
    ports.captureException(error);
    message.retry({ delaySeconds: 30 });
    return "failed";
  }
}

export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
) {
  if (!batch.messages.length) return;
  const ring = batch.messages.some(
    (message) => backgroundTaskMessageSchema.safeParse(message.body).data?.ring,
  );
  // Every message in a batch shares one attempt, including transport failures.
  const first = batch.messages[0]!;
  const outcome = await handleBackgroundQueueMessage(db, first, ports, ring);
  for (const message of batch.messages.slice(1)) {
    if (outcome === "failed") message.retry({ delaySeconds: 30 });
    else message.ack();
  }
  if (outcome !== "failed") await ports.afterSuccess?.();
}
