import {
  agentImportRunPurpose,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { createLogger, withSpan, type WorkerSpan } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";
import { getAgentByName } from "agents";
import { z } from "zod";

import { parsePurchaseAgentEvent, type PurchaseAgentEvent } from "./contracts";
import { dispatchInputForEvent } from "./queue-dispatch";
import { purchaseImportService, type PurchaseImportService } from "./service";

const log = createLogger("purchase-agent");

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
  service: PurchaseImportService,
  env: CloudflareBindings,
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
  const scope = z
    .object({
      public: z.object({ purpose: agentImportRunPurpose, agentId: z.string() }),
    })
    .parse(await service.loadRunScope({ runId: event.runId })).public;
  if (scope.agentId !== importRunAgentIdentity(event.runId, scope.purpose)) {
    throw new Error("Import run agent identity does not match its purpose");
  }
  const agent = await getAgentByName(env.PURCHASE_IMPORT_RUN, scope.agentId);
  const { accepted } = await agent.dispatch(
    dispatchInputForEvent(event, scope.purpose),
  );
  if (accepted && event.type === "start_or_resume")
    await service.updateAgentProgress({
      runId: event.runId,
      eventId: `coordinator-started:${event.eventId}`,
      phase: "preparing",
      detail: "Coordinator started",
    });
  if (
    event.type === "start_or_resume" &&
    !(await service.acknowledgeCoordinator({
      runId: event.runId,
      eventId: event.eventId,
    }))
  ) {
    // A crash or competing redelivery won the DB acknowledgement. The
    // operation id still makes this submission safe; acknowledge the queue
    // message so it cannot re-open a terminal generation.
    return "acknowledged_by_peer";
  }
  return "dispatched";
}

async function consumeMessage(
  message: Message<unknown>,
  service: PurchaseImportService,
  env: CloudflareBindings,
  span: WorkerSpan,
): Promise<void> {
  // SAFETY: Cloudflare Queue messages expose delivery attempts at runtime,
  // while the installed Workers type has not yet added the property.
  const attempts = (message as { attempts?: number }).attempts ?? 1;
  span.setAttribute("queue.attempts", attempts);
  let event: PurchaseAgentEvent | undefined;
  try {
    event = parsePurchaseAgentEvent(message.body);
    span.setAttributes({
      "run.id": event.runId,
      "event.type": event.type,
      "event.id": event.eventId,
    });
    span.setAttribute(
      "dispatch.outcome",
      await deliverEvent(event, service, env),
    );
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
        await service.markRunFailed({
          runId: event.runId,
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
  batch: MessageBatch<unknown>,
  env: CloudflareBindings,
): Promise<void> {
  const service = purchaseImportService(env);
  for (const message of batch.messages) {
    await withSpan("job.purchase_agent_event", (span) =>
      consumeMessage(message, service, env, span),
    );
  }
}
