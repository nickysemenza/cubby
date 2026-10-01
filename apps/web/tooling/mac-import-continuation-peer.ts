import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { PurchaseImportService } from "../../purchase-agent/src/service";

const resumedEvents: Array<{ runId: string; eventId: string }> = [];

/** Supply the coordinator's work-selection decision; the real queue and backend own resume. */
export default {
  fetch() {
    return Response.json({ resumedEvents });
  },
  async queue(
    batch: MessageBatch<unknown>,
    env: { CUBBY_PURCHASE_SERVICE: PurchaseImportService },
  ) {
    for (const message of batch.messages) {
      const event = purchaseAgentEvent.parse(message.body);
      // Photo descriptions and browser extraction are supplied by the composed
      // scenario. Only a native Sync retry should select work in this peer.
      if (event.type !== "retry") continue;
      await env.CUBBY_PURCHASE_SERVICE.claimNextWork({
        runId: event.runId,
        operationId: `native-resume:${event.eventId}`,
      });
      resumedEvents.push({ runId: event.runId, eventId: event.eventId });
    }
  },
};
