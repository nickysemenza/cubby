import {
  purchaseAgentEvent,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

export type { PurchaseAgentEvent };

const eventCandidate = z
  .object({ version: z.literal(1).optional() })
  .passthrough();
const queuedEventCandidate = z.union([
  z.string().transform((encoded) => eventCandidate.parse(JSON.parse(encoded))),
  eventCandidate,
]);

/**
 * Accept historical queue bodies while using the producer's event contract.
 * Bodies queued before `coordinatorModel` left the event still carry it; the
 * strict event object strips it.
 */
export function parsePurchaseAgentEvent(input: unknown): PurchaseAgentEvent {
  const candidate = queuedEventCandidate.parse(input);
  return purchaseAgentEvent.parse({
    ...candidate,
    version: candidate.version ?? 1,
  });
}

/** Queue redelivery converges on exactly one agent submission. */
export function purchaseAgentEventIdempotencyKey(
  event: PurchaseAgentEvent,
): string {
  return `purchase-agent:${event.runId}:${event.type}:${event.eventId}`;
}
