import { z } from "zod";

/** Telemetry keeps its version-1 transport; background messages only wake durable Jobs. */
export const queueMessageEnvelope = {
  version: z.literal(1),
};

export const BACKGROUND_TASK_MESSAGE_VERSION = 3;

/**
 * The one claim a delayed recovery message names, sent at that claim's lease
 * expiry: it runs only if that claim is still leased and its lease lapsed (its
 * invocation died), and otherwise exits without running or sending anything.
 */
const permitRecovery = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("job"), id: z.uuid(), lease: z.uuid() }),
  z.strictObject({ kind: z.literal("image"), id: z.uuid(), attempt: z.uuid() }),
]);
export type PermitRecovery = z.infer<typeof permitRecovery>;

/**
 * Version 3 carries no execution payload: each message is a permit to run one
 * background unit chosen in Postgres, or (`recover`) to recover one specific
 * claim. `ring` also rings companions if parked device work came due. A
 * retired field makes an older message unreadable, which is still a permit.
 */
export const backgroundTaskMessageSchema = z.strictObject({
  version: z.literal(BACKGROUND_TASK_MESSAGE_VERSION),
  queueType: z.literal("background"),
  ring: z.literal(true).optional(),
  recover: permitRecovery.optional(),
});
export type BackgroundTaskMessage = z.infer<typeof backgroundTaskMessageSchema>;
export type BackgroundTaskMessageInput = z.input<
  typeof backgroundTaskMessageSchema
>;
