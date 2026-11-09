import { z } from "zod";

/** Telemetry keeps its version-1 transport; background messages only wake durable Jobs. */
export const queueMessageEnvelope = {
  version: z.literal(1),
};

export const BACKGROUND_TASK_MESSAGE_VERSION = 3;

/**
 * Version 3 carries no execution payload. Pending predecessor work is migrated in
 * Postgres. `ring` also rings companions if parked device work came due.
 */
export const backgroundTaskMessageSchema = z.strictObject({
  version: z.literal(BACKGROUND_TASK_MESSAGE_VERSION),
  queueType: z.literal("background"),
  ring: z.literal(true).optional(),
  /** Scheduling hint only; unfinished domain work remains in Postgres. */
  afterDrain: z.string().min(1).max(128).optional(),
});
export type BackgroundTaskMessage = z.infer<typeof backgroundTaskMessageSchema>;
export type BackgroundTaskMessageInput = z.input<
  typeof backgroundTaskMessageSchema
>;
