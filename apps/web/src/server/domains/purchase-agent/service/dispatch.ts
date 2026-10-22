import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";

import type { PurchaseAgentEvent } from "./contracts";
import { dispatchInputForEvent } from "./dispatch-input";
import type { PurchaseDispatchEnvironment } from "./environment";

export async function deliverPurchaseDispatch(
  event: PurchaseAgentEvent,
  env: PurchaseDispatchEnvironment,
): Promise<"dispatched" | "fenced" | "acknowledged_by_peer"> {
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
  if (scope.generation !== event.generation) return "fenced";
  if (scope.agentId !== importRunAgentIdentity(event.runId, scope.purpose)) {
    throw new Error("Import run agent identity does not match its purpose");
  }
  const { accepted } = await env
    .coordinator(scope.agentId)
    .dispatch(dispatchInputForEvent(event, scope.purpose));
  if (accepted && event.type === "start_or_resume")
    await services.updateAgentProgress({
      eventId: `coordinator-started:${event.eventId}`,
      generation: event.generation,
      sequence: 0,
      phase: "preparing",
      detail: "Coordinator started",
    });
  if (
    event.type === "start_or_resume" &&
    !(await services.acknowledgeCoordinator(event.eventId))
  ) {
    // A crash or competing redelivery won the DB acknowledgement. The
    // operation id still makes this submission safe; complete this Job
    // so it cannot re-open a terminal generation.
    return "acknowledged_by_peer";
  }
  return "dispatched";
}
