import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";

export interface PurchaseAgentQueueProducer {
  send(message: PurchaseAgentEvent): Promise<void>;
}
