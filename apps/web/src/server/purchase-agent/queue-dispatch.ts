import {
  purchaseAgentEventIdempotencyKey,
  type PurchaseAgentEvent,
} from "./contracts";
import type { DispatchInput } from "./environment";

/**
 * One queue event as the coordinator reads it. The Durable Object needs the
 * private run UUID, but the signal is part of the authenticated, member-
 * visible transcript, so its body carries only the public handle.
 */
export function dispatchInputForEvent(
  event: PurchaseAgentEvent,
  purpose: DispatchInput["identity"]["purpose"],
): DispatchInput {
  const { runId: _privateRunId, ...observableEvent } = event;
  return {
    identity: { runId: event.runId, purpose },
    // Queue redelivery converges on exactly one submission.
    operationId: purchaseAgentEventIdempotencyKey(event),
    signal: {
      type: `purchase-import.${event.type}`,
      attributes: { eventId: event.eventId },
      body: JSON.stringify(observableEvent),
    },
  };
}
