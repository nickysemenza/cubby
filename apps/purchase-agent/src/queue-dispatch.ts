import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import type { AgentDispatchRequest } from "@flue/runtime";

import {
  purchaseAgentEventIdempotencyKey,
  type PurchaseAgentEvent,
} from "./contracts";

export type PurchaseAgentDispatch = (
  request: AgentDispatchRequest,
) => Promise<void>;

export async function dispatchPurchaseAgentEvent(
  event: PurchaseAgentEvent,
  send: PurchaseAgentDispatch,
): Promise<void> {
  const { runId: _privateRunId, ...observableEvent } = event;
  await send({
    id: importRunAgentIdentity(event.runId, event.purpose ?? "account_sync"),
    initialData: {
      runId: event.runId,
      coordinatorModel: event.coordinatorModel,
      purpose: event.purpose,
    },
    idempotencyKey: purchaseAgentEventIdempotencyKey(event),
    message: {
      kind: "signal",
      type: `purchase-import.${event.type}`,
      // The durable instance needs the UUID in initialData, but the signal is
      // part of the authenticated user-visible transcript and therefore uses
      // only the public handle.
      body: JSON.stringify(observableEvent),
      attributes: { eventId: event.eventId },
    },
  });
}
