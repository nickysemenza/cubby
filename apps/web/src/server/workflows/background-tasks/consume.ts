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

/** Every delivery wakes durable work; unreadable bodies and failed drains always ack. */
export async function handleBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
  ports: BackgroundQueueConsumerPorts,
): Promise<BackgroundQueueMessageOutcome> {
  const parsed = backgroundTaskMessageSchema.safeParse(message.body);
  try {
    if (ports.handlers)
      await (
        await import("~/server/generic/jobs/service/jobs")
      ).drainDueJobs(db, ports.handlers);
    else await drainProductionJobs(db);
    return parsed.success ? "succeeded" : "unreadable";
  } catch (error) {
    ports.captureException(error);
    return "failed";
  } finally {
    message.ack();
  }
}

export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
) {
  let succeeded = false;
  // One wake drains a bounded fair budget; duplicate wake messages need no second drain.
  for (const message of batch.messages) {
    if (succeeded) {
      message.ack();
      continue;
    }
    const outcome = await handleBackgroundQueueMessage(db, message, ports);
    succeeded ||= outcome === "succeeded" || outcome === "unreadable";
  }
  if (succeeded) await ports.afterSuccess?.();
}
