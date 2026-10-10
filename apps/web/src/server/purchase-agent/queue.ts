import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { createLogger, withSpan, type WorkerSpan } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";

import { parsePurchaseAgentEvent, type PurchaseAgentEvent } from "./contracts";
import type {
  PurchaseAgentQueueEnvironment,
  PurchaseAgentQueueBatch,
  PurchaseAgentQueueDeliveredMessage,
} from "./environment";
import { dispatchInputForEvent } from "./queue-dispatch";

const log = createLogger("purchase-agent");

/**
 * How one queue delivery ended, recorded as the `dispatch.outcome` attribute
 * on its Workers Traces span. The queue hop starts a new native trace (queue
 * delivery does not propagate trace context), so `run.id` on the same span is
 * the join key back to the producer's `job.*` spans.
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
  env: PurchaseAgentQueueEnvironment,
): Promise<
  Extract<DispatchOutcome, "dispatched" | "fenced" | "acknowledged_by_peer">
> {
  const services = env.run(event.runId);
  if (await services.coordinatorRetired()) return "fenced";
  // Only run-start deliveries participate in the dispatch generation fence.
  if (
    event.type === "start_or_resume" &&
    !(await services.canDispatchCoordinator(event.eventId))
  ) {
    return "fenced";
  }
  const scope = await services.loadScope();
  if (scope.agentId !== importRunAgentIdentity(event.runId, scope.purpose)) {
    throw new Error("Import run agent identity does not match its purpose");
  }
  const { accepted } = await env
    .coordinator(scope.agentId)
    .dispatch(dispatchInputForEvent(event, scope.purpose));
  if (accepted && event.type === "start_or_resume")
    await services.updateAgentProgress({
      eventId: `coordinator-started:${event.eventId}`,
      phase: "preparing",
      detail: "Coordinator started",
    });
  if (
    event.type === "start_or_resume" &&
    !(await services.acknowledgeCoordinator(event.eventId))
  ) {
    // A crash or competing redelivery won the DB acknowledgement. The
    // operation id still makes this submission safe; acknowledge the queue
    // message so it cannot re-open a terminal generation.
    return "acknowledged_by_peer";
  }
  return "dispatched";
}

async function consumeMessage(
  message: PurchaseAgentQueueDeliveredMessage,
  env: PurchaseAgentQueueEnvironment,
  span: WorkerSpan,
): Promise<void> {
  const { attempts } = message;
  span.setAttribute("queue.attempts", attempts);
  let event: PurchaseAgentEvent | undefined;
  try {
    event = parsePurchaseAgentEvent(message.body);
    span.setAttributes({
      "run.id": event.runId,
      "event.type": event.type,
      "event.id": event.eventId,
    });
    span.setAttribute("dispatch.outcome", await deliverEvent(event, env));
    message.ack();
  } catch (error) {
    log.error("queue event was not dispatched", { error });
    // `withSentry` only auto-captures a throw that escapes the handler, and
    // this consumer never lets one escape, so report it here.
    Sentry.captureException(error);
    // Invalid bodies cannot succeed on redelivery; valid events retry after a
    // transient agent or service admission failure.
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
        await env.run(event.runId).markRunFailed({
          operationId: `queue:${event.eventId}`,
          failureCode: "agent_failed",
          detail: "Purchase-agent queue delivery exhausted its retry budget",
          dispatchEventId: event.eventId,
        });
      }
    } catch (markError) {
      log.error("could not mark the run failed", { error: markError });
      Sentry.captureException(markError);
    }
    message.ack();
  }
}

export async function consumePurchaseAgentQueue(
  batch: PurchaseAgentQueueBatch,
  env: PurchaseAgentQueueEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    await withSpan("job.purchase_agent_event", (span) =>
      consumeMessage(message, env, span),
    );
  }
}
