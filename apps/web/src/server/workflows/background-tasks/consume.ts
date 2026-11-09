import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { runBackgroundRound } from "~/server/generic/background/work-round";
import type { JobOutcome } from "~/server/generic/jobs/service/jobs";
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
  readonly drainJobs?: (
    db: Database,
    options: { afterDrain?: string },
  ) => Promise<JobOutcome[]>;
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
  options: { ring?: boolean; afterDrain?: string } = {},
): Promise<BackgroundQueueMessageOutcome> {
  const parsed = backgroundTaskMessageSchema.safeParse(message.body);
  const ring = options.ring ?? parsed.data?.ring ?? false;
  const afterDrain = options.afterDrain ?? parsed.data?.afterDrain;
  try {
    if (ring)
      await (
        await import("~/server/domains/image-processing/repo/image-processing-ring")
      ).ringDueDeviceWork(db);
    if (ports.handlers) {
      const round = await runBackgroundRound(db, ports.handlers, [], {
        afterDrain,
      });
      if (round.failures.length === 1) throw round.failures[0];
      if (round.failures.length)
        throw new AggregateError(round.failures, "Background pages failed");
    } else await (ports.drainJobs ?? drainProductionJobs)(db, { afterDrain });
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
  let continuation: { afterDrain: string; timestamp?: number } | undefined;
  for (const message of batch.messages) {
    const afterDrain = backgroundTaskMessageSchema.safeParse(message.body).data
      ?.afterDrain;
    if (afterDrain === undefined) continue;
    const timestamp = message.timestamp?.getTime();
    // Plain wakes and an older redelivery cannot reset a newer continuation.
    if (
      !continuation ||
      (timestamp !== undefined &&
        (continuation.timestamp === undefined ||
          timestamp > continuation.timestamp))
    )
      continuation = { afterDrain, timestamp };
  }
  // Every message in a batch shares one attempt, including transport failures.
  const first = batch.messages[0]!;
  const outcome = await handleBackgroundQueueMessage(db, first, ports, {
    ring,
    afterDrain: continuation?.afterDrain,
  });
  for (const message of batch.messages.slice(1)) {
    if (outcome === "failed") message.retry({ delaySeconds: 30 });
    else message.ack();
  }
  if (outcome !== "failed") await ports.afterSuccess?.();
}
