import { dispatch } from "@flue/runtime";

import {
  parsePurchaseAgentEvent,
  type PurchaseAgentEventCandidate,
} from "./contracts";
import { PurchaseImportRun } from "./purchase-import-run";
import { dispatchPurchaseAgentEvent } from "./queue-dispatch";
import { z } from "zod";

const queueBody: z.ZodType<PurchaseAgentEventCandidate> = z.union([
  z.string(),
  z.object({
    version: z.literal(1).optional(),
    runId: z.string().optional(),
    publicId: z.string().optional(),
    coordinatorModel: z.enum(["gpt-5.6-terra", "gpt-5.6-sol"]).optional(),
    eventId: z.string().optional(),
    type: z.string().optional(),
    connectionId: z.string().optional(),
    commandId: z.string().optional(),
    retryOf: z.string().optional(),
  }),
]);

export default {
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    for (const message of batch.messages) {
      try {
        await dispatchPurchaseAgentEvent(
          parsePurchaseAgentEvent(queueBody.parse(message.body)),
          async (request) => {
            await dispatch(PurchaseImportRun, request);
          },
        );
        message.ack();
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error) {
          console.error("purchase-agent queue event was not dispatched", error);
        }
        // Invalid bodies cannot succeed on redelivery; valid events retry after
        // a transient Flue/service admission failure.
        try {
          parsePurchaseAgentEvent(queueBody.parse(message.body));
          message.retry();
        } catch {
          message.ack();
        }
      }
    }
  },
};
