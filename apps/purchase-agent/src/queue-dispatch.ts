import type { AgentDispatchRequest } from "@flue/runtime";

import {
  purchaseAgentEventIdempotencyKey,
  purchaseImportAgentIdentity,
  type PurchaseAgentEvent,
} from "./contracts";

export type PurchaseAgentDispatch = (
  request: AgentDispatchRequest,
) => Promise<void>;

type PurchaseAgentSignalAttributes = {
  eventId: string;
  purpose?:
    | "account_sync"
    | "purchase_validation"
    | "product_enrichment"
    | "photo_inventory";
};

export async function dispatchPurchaseAgentEvent(
  event: PurchaseAgentEvent,
  send: PurchaseAgentDispatch,
): Promise<void> {
  const { runId: _privateRunId, ...observableEvent } = event;
  const attributes: PurchaseAgentSignalAttributes = { eventId: event.eventId };
  await send({
    id: purchaseImportAgentIdentity(event.runId, event.purpose),
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
      attributes,
    },
  });
}
