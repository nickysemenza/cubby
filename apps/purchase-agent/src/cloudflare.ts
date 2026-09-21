import { dispatch } from "@flue/runtime";
import type { CloudflareContext } from "@flue/runtime/cloudflare";

import {
  parsePurchaseAgentEvent,
  type PurchaseAgentEventCandidate,
} from "./contracts";
import { PurchaseImportRun } from "./purchase-import-run";
import { dispatchPurchaseAgentEvent } from "./queue-dispatch";
import { purchaseImportService } from "./service";
import { z } from "zod";

const queueBody: z.ZodType<PurchaseAgentEventCandidate> = z.union([
  z.string(),
  z.object({
    version: z.literal(1).optional(),
    runId: z.string().optional(),
    publicId: z.string().optional(),
    coordinatorModel: z.enum(["gpt-5.6-terra", "gpt-5.6-sol"]).optional(),
    purpose: z
      .enum(["account_sync", "purchase_validation", "product_enrichment"])
      .optional(),
    eventId: z.string().optional(),
    type: z.string().optional(),
    connectionId: z.string().optional(),
    commandId: z.string().optional(),
    retryOf: z.string().optional(),
  }),
]);

export default {
  async queue(
    batch: MessageBatch<unknown>,
    env: CloudflareContext["env"],
  ): Promise<void> {
    const service = purchaseImportService(env);
    for (const message of batch.messages) {
      try {
        const event = parsePurchaseAgentEvent(queueBody.parse(message.body));
        // Only run-start deliveries participate in the dispatch generation
        // fence. Browser signals use their own stable command idempotency.
        if (
          event.type === "start_or_resume" &&
          !(await service.canDispatchCoordinator({
            runId: event.runId,
            eventId: event.eventId,
          }))
        ) {
          message.ack();
          continue;
        }
        await dispatchPurchaseAgentEvent(event, async (request) => {
          await dispatch(PurchaseImportRun, request);
        });
        if (
          event.type === "start_or_resume" &&
          !(await service.acknowledgeCoordinator({
            runId: event.runId,
            eventId: event.eventId,
          }))
        ) {
          // A crash or competing redelivery won the DB acknowledgement. The
          // idempotency key still makes this Flue dispatch safe; acknowledge
          // the queue message so it cannot re-open a terminal generation.
          message.ack();
          continue;
        }
        message.ack();
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error) {
          console.error("purchase-agent queue event was not dispatched", error);
        }
        // Invalid bodies cannot succeed on redelivery; valid events retry after
        // a transient Flue/service admission failure.
        try {
          const event = parsePurchaseAgentEvent(queueBody.parse(message.body));
          // SAFETY: Cloudflare Queue messages expose delivery attempts at runtime,
          // while the installed Workers type has not yet added the property.
          const attempts = (message as { attempts?: number }).attempts ?? 1;
          if (attempts >= 3) {
            if (event.type === "start_or_resume") {
              await service.markRunFailed({
                runId: event.runId,
                operationId: `queue:${event.eventId}`,
                failureCode: "flue_failed",
                detail:
                  "Purchase-agent queue delivery exhausted its retry budget",
                dispatchEventId: event.eventId,
              });
            }
            message.ack();
          } else message.retry();
        } catch {
          message.ack();
        }
      }
    }
  },
};
