import { z } from "zod";
import { backgroundTaskSchema } from "./background-tasks";

/**
 * Cubby runs two Cloudflare Queues rather than one. The split is deliberate:
 * consumer settings (`max_batch_timeout`, `max_batch_size`, `max_concurrency`)
 * are per-queue, and the two workloads want opposite values — background
 * tasks need `max_batch_timeout: 0` for latency, while telemetry wants a 5s
 * window to amortize its inserts. Batch timeout is applied before the consumer
 * runs, so a merged queue could not recover it in-handler, and a single FIFO
 * backlog would let a telemetry burst delay user-visible work.
 *
 * `queueType` lives on every message body anyway so the message format is
 * merge-ready: a future merged consumer switches on it instead of `batch.queue`.
 * Today the consumer routes on `batch.queue` — the transport is the authority.
 *
 * Note there is deliberately no combined `discriminatedUnion("queueType", …)`:
 * Zod rejects duplicate discriminator values, and both telemetry variants share
 * `queueType: "telemetry"` (they discriminate among themselves on `type`).
 */

/**
 * Shared by every telemetry message. Spread as a field map rather than
 * composed with `.extend()`. Background tasks moved to their own version-2
 * envelope below; telemetry deliberately stays on version 1.
 */
export const queueMessageEnvelope = {
  version: z.literal(1),
};

export const BACKGROUND_TASK_MESSAGE_VERSION = 2;

/**
 * A background message is the whole task. Version 2 replaced the version-1
 * wakeup (`batchId` + `jobId` pointing at a Postgres execution row); a
 * version-1 body no longer parses and follows the queue's retry/drop path.
 */
export const backgroundTaskMessageSchema = z.strictObject({
  version: z.literal(BACKGROUND_TASK_MESSAGE_VERSION),
  queueType: z.literal("background"),
  task: backgroundTaskSchema,
});
export type BackgroundTaskMessage = z.infer<typeof backgroundTaskMessageSchema>;
export type BackgroundTaskMessageInput = z.input<
  typeof backgroundTaskMessageSchema
>;
