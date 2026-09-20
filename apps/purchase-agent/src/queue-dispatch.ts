import type { AgentDispatchRequest } from "@flue/runtime";

import {
  purchaseAgentEventIdempotencyKey,
  purchaseImportAgentIdentity,
  type PurchaseAgentEvent,
} from "./contracts";

export type PurchaseAgentDispatch = (
  request: AgentDispatchRequest,
) => Promise<void>;

export async function dispatchPurchaseAgentEvent(
  event: PurchaseAgentEvent,
  send: PurchaseAgentDispatch,
): Promise<void> {
  await send({
    id: purchaseImportAgentIdentity(event.runId),
    initialData: { runId: event.runId },
    idempotencyKey: purchaseAgentEventIdempotencyKey(event),
    message: {
      kind: "signal",
      type: `purchase-import.${event.type}`,
      body: JSON.stringify(event),
      attributes: {
        runId: event.runId,
        eventId: event.eventId,
      },
    },
  });
}
