import { withSpan, type WorkerSpan } from "@cubby/worker-tracing";
import { dispatch } from "@flue/runtime";
import type { CloudflareContext } from "@flue/runtime/cloudflare";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import {
  parsePurchaseAgentEvent,
  type PurchaseAgentEvent,
  type PurchaseAgentEventCandidate,
} from "./contracts";
import { PurchaseImportRun } from "./purchase-import-run";
import { dispatchPurchaseAgentEvent } from "./queue-dispatch";
import { purchaseAgentSentryOptions } from "./sentry-bridge";
import { purchaseImportService } from "./service";

const queueBody: z.ZodType<PurchaseAgentEventCandidate> = z.union([
  z.string(),
  z.object({
    version: z.literal(1).optional(),
    runId: z.string().optional(),
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

type QueueService = ReturnType<typeof purchaseImportService>;

/**
 * How one queue delivery ended, recorded as the `dispatch.outcome` attribute
 * on its Workers Traces span. The queue hop starts a new native trace (queue
 * delivery does not propagate trace context), so `run.id` on the same span is
 * the join key back to the web Worker's `job.*` spans.
 */
type DispatchOutcome =
  | "dispatched"
  | "fenced"
  | "acknowledged_by_peer"
  | "retry"
  | "dead"
  | "invalid";

async function deliverEvent(
  event: PurchaseAgentEvent,
  service: QueueService,
): Promise<
  Extract<DispatchOutcome, "dispatched" | "fenced" | "acknowledged_by_peer">
> {
  // Only run-start deliveries participate in the dispatch generation fence.
  // Browser signals use their own stable command idempotency.
  if (
    event.type === "start_or_resume" &&
    !(await service.canDispatchCoordinator({
      runId: event.runId,
      eventId: event.eventId,
    }))
  ) {
    return "fenced";
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
    // idempotency key still makes this Flue dispatch safe; acknowledge the
    // queue message so it cannot re-open a terminal generation.
    return "acknowledged_by_peer";
  }
  return "dispatched";
}

async function consumeMessage(
  message: Message<unknown>,
  service: QueueService,
  span: WorkerSpan,
): Promise<void> {
  // SAFETY: Cloudflare Queue messages expose delivery attempts at runtime,
  // while the installed Workers type has not yet added the property.
  const attempts = (message as { attempts?: number }).attempts ?? 1;
  span.setAttribute("queue.attempts", attempts);
  let event: PurchaseAgentEvent | undefined;
  try {
    event = parsePurchaseAgentEvent(queueBody.parse(message.body));
    span.setAttributes({
      "run.id": event.runId,
      "event.type": event.type,
      "event.id": event.eventId,
    });
    span.setAttribute("dispatch.outcome", await deliverEvent(event, service));
    message.ack();
  } catch (error) {
    console.error("purchase-agent queue event was not dispatched", error);
    // `withSentry` only auto-captures a throw that escapes the handler, and
    // this consumer never lets one escape, so report it here.
    Sentry.captureException(error);
    // Invalid bodies cannot succeed on redelivery; valid events retry after a
    // transient Flue/service admission failure.
    if (!event) {
      span.setAttribute("dispatch.outcome", "invalid");
      message.ack();
      return;
    }
    if (attempts < 3) {
      span.setAttribute("dispatch.outcome", "retry");
      message.retry();
      return;
    }
    span.setAttribute("dispatch.outcome", "dead");
    try {
      if (event.type === "start_or_resume") {
        await service.markRunFailed({
          runId: event.runId,
          operationId: `queue:${event.eventId}`,
          failureCode: "flue_failed",
          detail: "Purchase-agent queue delivery exhausted its retry budget",
          dispatchEventId: event.eventId,
        });
      }
    } catch (markError) {
      console.error("purchase-agent could not mark the run failed", markError);
      Sentry.captureException(markError);
    }
    message.ack();
  }
}

// `withSentry` initializes the SDK for each queue invocation so the captures
// above resolve against a client; native Workers Traces own the spans here
// (tracesSampleRate 0), the same split as usda-api and upc-lookup. Flue's
// generated Worker entry composes this default export into the final Worker,
// so it must stay an object of non-HTTP handlers with no `fetch`.
export default Sentry.withSentry(
  (env: CloudflareContext["env"]) => purchaseAgentSentryOptions(env, 0),
  {
    async queue(
      batch: MessageBatch<unknown>,
      env: CloudflareContext["env"],
    ): Promise<void> {
      const service = purchaseImportService(env);
      for (const message of batch.messages) {
        await withSpan("job.purchase_agent_event", (span) =>
          consumeMessage(message, service, span),
        );
      }
    },
  },
);
