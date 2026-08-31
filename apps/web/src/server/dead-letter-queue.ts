import {
  type BackgroundQueueMessage,
  backgroundQueueMessageSchema,
} from "@cubby/schemas/queue-messages";
import { telemetryMessageV1Schema } from "@cubby/schemas/telemetry";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { abandonBackgroundJob } from "~/server/repo/background-jobs";

const DEAD_LETTER_REASON =
  "Queue delivery exhausted; message dead-lettered without ever completing";

interface DeadLetterDeliveredMessage {
  readonly body: unknown;
  ack(): void;
}

export interface DeadLetterQueueBatch {
  readonly queue: "cubby-background-dlq" | "cubby-telemetry-dlq";
  readonly messages: readonly DeadLetterDeliveredMessage[];
}

/**
 * `captureException` has no default on purpose. A default no-op would make a
 * silent-alerting regression invisible, and the alternative — importing the
 * Sentry SDK here — would pull it into every test that touches this module.
 * The caller owns it.
 */
export interface DeadLetterQueuePorts {
  readonly abandonBackgroundJob: typeof abandonBackgroundJob;
  readonly captureException: (error: UnparsedError) => void;
}

export const productionDeadLetterQueuePorts = {
  abandonBackgroundJob,
} satisfies Omit<DeadLetterQueuePorts, "captureException">;

/**
 * Drain a dead-letter queue.
 *
 * Every message is acked, always. These queues have no dead letter queue of
 * their own, so a retry here either loops forever or is silently dropped by the
 * platform — neither is better than recording the loss and moving on.
 *
 * Bodies are parsed here, at the I/O boundary, so the handlers below take a
 * named domain type rather than passing `unknown` further inward.
 */
export async function processDeadLetterBatch(
  db: Database,
  batch: DeadLetterQueueBatch,
  ports: DeadLetterQueuePorts,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue === "cubby-background-dlq") {
        const parsed = backgroundQueueMessageSchema.safeParse(message.body);
        if (parsed.success) {
          await settleBackgroundDeadLetter(db, parsed.data, ports);
        } else {
          // Unreadable body: there is no job id to settle, so the row (if any)
          // is left for the stranded sweep or a human.
          console.error("[dead-letter] unreadable background message", {
            issues: parsed.error.issues,
          });
          ports.captureException(
            new Error("Unreadable message in cubby-background-dlq"),
          );
        }
      } else {
        // Telemetry has no durable row behind it — persistence failed
        // repeatedly, so the event is simply lost. Record its identity, not its
        // fields, which carry user and client ids. A dead-letter table would be
        // more machinery than a best-effort usage event is worth.
        const parsed = telemetryMessageV1Schema.safeParse(message.body);
        const identity = parsed.success
          ? `type=${parsed.data.type} eventId=${parsed.data.eventId}`
          : "unreadable body";
        console.error(`[dead-letter] telemetry event lost ${identity}`);
        ports.captureException(
          new Error(`Telemetry event dead-lettered: ${identity}`),
        );
      }
    } catch (error) {
      // A failure to record the loss must not strand the rest of the batch.
      console.error(
        `[dead-letter] failed to handle message from ${batch.queue}`,
        error,
      );
      ports.captureException(error);
    } finally {
      message.ack();
    }
  }
}

async function settleBackgroundDeadLetter(
  db: Database,
  message: BackgroundQueueMessage,
  ports: DeadLetterQueuePorts,
): Promise<void> {
  const { batchId, jobId, kind } = message;
  const settled = await ports.abandonBackgroundJob(
    db,
    jobId,
    DEAD_LETTER_REASON,
  );
  console.error(
    `[dead-letter] background job abandoned batch=${batchId} job=${jobId} kind=${kind} settled=${settled}`,
  );
  ports.captureException(
    new Error(`Background job dead-lettered: ${kind} (job ${jobId})`),
  );
}
