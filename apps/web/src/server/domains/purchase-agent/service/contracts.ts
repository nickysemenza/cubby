import { type PurchaseAgentEvent } from "@cubby/schemas/purchase-import";

export type { PurchaseAgentEvent };

/** Job retries converges on exactly one agent submission. */
export function purchaseAgentEventIdempotencyKey(
  event: PurchaseAgentEvent,
): string {
  return `purchase-agent:${event.runId}:${event.type}:${event.eventId}`;
}
