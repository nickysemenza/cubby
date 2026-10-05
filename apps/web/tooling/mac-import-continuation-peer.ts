import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import type { MessageBatch } from "@cloudflare/workers-types";

const retryEvents: Array<{ runId: string; eventId: string }> = [];

/**
 * Stands in for the coordinator's queue consumer: records each native Sync
 * retry the real queue delivered. The scenario then makes the coordinator's
 * work-selection decision itself (`mac-browser-import-scenario.ts`).
 */
export default {
  fetch() {
    return Response.json({ retryEvents });
  },
  queue(batch: MessageBatch<unknown>) {
    for (const message of batch.messages) {
      const event = purchaseAgentEvent.parse(message.body);
      // Photo descriptions and browser extraction are supplied by the composed
      // scenario. Only a native Sync retry selects work.
      if (event.type === "retry")
        retryEvents.push({ runId: event.runId, eventId: event.eventId });
    }
  },
};
