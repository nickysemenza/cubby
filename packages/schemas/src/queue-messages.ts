import { z } from "zod";
import { backgroundJobKindSchema } from "./background-jobs";

/**
 * Cubby runs two Cloudflare Queues rather than one. The split is deliberate:
 * consumer settings (`max_batch_timeout`, `max_batch_size`, `max_concurrency`,
 * `dead_letter_queue`) are per-queue, and the two workloads want opposite
 * values — background wakeups need `max_batch_timeout: 0` for latency, while
 * telemetry wants a 5s window to amortize its inserts. Batch timeout is applied
 * before the consumer runs, so a merged queue could not recover it in-handler,
 * and a single FIFO backlog would let a telemetry burst delay user-visible work.
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
 * Shared by every queue message on every queue. Spread as a field map rather
 * than composed with `.extend()` — `packages/schemas` bans Zod combinators.
 */
export const queueMessageEnvelope = {
  version: z.literal(1),
};

export const QUEUE_MESSAGE_VERSION = 1;

export const backgroundQueueMessageSchema = z.strictObject({
  ...queueMessageEnvelope,
  queueType: z.literal("background"),
  // Plain strings, not `z.uuid()`: the id's real validation is the Postgres
  // lookup in `processBackgroundJob`, which settles an unknown job as `skipped`.
  // Enforcing a format here would only reject ids the DB would have handled.
  batchId: z.string().min(1),
  jobId: z.string().min(1),
  /** Batch kind gates workflow continuation checks without another DB read. */
  kind: backgroundJobKindSchema,
});
export type BackgroundQueueMessage = z.infer<
  typeof backgroundQueueMessageSchema
>;
