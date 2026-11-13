import { z } from "zod";

/** Telemetry keeps its version-1 transport; background messages only wake durable Jobs. */
export const queueMessageEnvelope = {
  version: z.literal(1),
};

export const BACKGROUND_TASK_MESSAGE_VERSION = 3;

export const backgroundTaskMessageSchema = z.strictObject({
  version: z.literal(BACKGROUND_TASK_MESSAGE_VERSION),
  queueType: z.literal("background"),
  ring: z.literal(true).optional(),
});
export type BackgroundTaskMessage = z.infer<typeof backgroundTaskMessageSchema>;
export type BackgroundTaskMessageInput = z.input<
  typeof backgroundTaskMessageSchema
>;
