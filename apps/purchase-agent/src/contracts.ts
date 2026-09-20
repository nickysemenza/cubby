import { z } from "zod";

const nonEmptyId = z.string().trim().min(1).max(256);

const purchaseAgentEventBaseSchema = z.object({
  version: z.literal(1).default(1),
  runId: z.uuid(),
  publicId: z
    .string()
    .regex(/^PIR-[A-Z0-9]{10}$/u)
    .optional(),
  coordinatorModel: z.enum(["gpt-5.6-terra", "gpt-5.6-sol"]).optional(),
  eventId: nonEmptyId,
});

const purchaseAgentEventSchema = z.discriminatedUnion("type", [
  purchaseAgentEventBaseSchema.extend({ type: z.literal("start_or_resume") }),
  purchaseAgentEventBaseSchema.extend({
    type: z.literal("browser_connected"),
    connectionId: nonEmptyId.optional(),
  }),
  purchaseAgentEventBaseSchema.extend({
    type: z.literal("browser_result"),
    commandId: nonEmptyId,
  }),
  purchaseAgentEventBaseSchema.extend({
    type: z.literal("retry"),
    retryOf: nonEmptyId,
  }),
]);

export type PurchaseAgentEvent = z.infer<typeof purchaseAgentEventSchema>;

type PurchaseAgentEventCandidateObject = {
  version?: 1;
  runId?: string;
  publicId?: string;
  coordinatorModel?: "gpt-5.6-terra" | "gpt-5.6-sol";
  eventId?: string;
  type?: string;
  connectionId?: string;
  commandId?: string;
  retryOf?: string;
};

export type PurchaseAgentEventCandidate =
  | string
  | PurchaseAgentEventCandidateObject;

const purchaseAgentEventCandidateSchema = z
  .union([
    purchaseAgentEventSchema,
    z.string().transform((value) => {
      const decoded: unknown = JSON.parse(value);
      return decoded;
    }),
  ])
  .pipe(purchaseAgentEventSchema);

export function parsePurchaseAgentEvent(
  input: PurchaseAgentEventCandidate,
): PurchaseAgentEvent {
  return purchaseAgentEventCandidateSchema.parse(input);
}

/** Flue instance ids are stable per ImportRun, never per queue delivery. */
export function purchaseImportAgentIdentity(runId: string): string {
  return `import-run:${z.uuid().parse(runId)}`;
}

/** Queue redelivery converges on exactly one Flue submission. */
export function purchaseAgentEventIdempotencyKey(
  event: PurchaseAgentEvent,
): string {
  return `purchase-agent:${event.runId}:${event.type}:${event.eventId}`;
}
