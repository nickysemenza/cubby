import { importRunIdFromAgentIdentity } from "@cubby/schemas/import-run-agent";
import { observe, type FlueEvent } from "@flue/runtime";

import {
  purchaseImportService,
  type AgentUsageEvent,
  type PurchaseImportService,
} from "./service";

const attempts = new Map<string, number>();

function attemptKey(event: FlueEvent): string | undefined {
  return event.instanceId && event.submissionId
    ? `${event.instanceId}:${event.submissionId}`
    : undefined;
}

type TurnEvent = Extract<FlueEvent, { type: "turn" }>;

export function usageEventForTurn(
  runId: string,
  event: TurnEvent,
  attempt: number,
): AgentUsageEvent {
  const usage = event.response.usage;
  return {
    runId,
    eventId: `model-turn:${event.submissionId ?? "direct"}:${attempt}:${event.turnId}`,
    provider: event.request.providerId,
    model: event.request.requestedModel,
    feature: "purchase_import_agent",
    operation: `flue.${event.purpose}`,
    attempt,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    durationMs: event.durationMs,
    status: event.isError ? "failed" : "succeeded",
    gatewayLogId: event.response.gatewayLogId,
    estimatedCost: usage?.cost.total,
  };
}

export function installRunTelemetry(): void {
  observe(async (event, context) => {
    const runId = importRunIdFromAgentIdentity(event.instanceId);
    if (!runId) return;
    const service = purchaseImportService(context.env);
    const key = attemptKey(event);

    if (event.type === "submission_running") {
      if (key) attempts.set(key, event.attemptCount);
      await service.updateAgentProgress({
        runId,
        eventId: `submission-running:${event.submissionId}:${event.attemptCount}`,
        phase: "preparing",
        detail: "Coordinator started",
      });
      return;
    }

    if (event.type === "turn") {
      const attempt = (key ? attempts.get(key) : undefined) ?? 1;
      await service.recordAgentUsage(usageEventForTurn(runId, event, attempt));
      return;
    }

    if (event.type !== "submission_settled") return;
    if (key) attempts.delete(key);
    await settleSubmission(service, runId, event);
  });
}

type SettledEvent = Extract<FlueEvent, { type: "submission_settled" }>;

/**
 * A completed submission is not a completed run: the coordinator may simply
 * have stopped calling tools. The server decides whether the run is still
 * legitimately open (a browser command in flight) or needs review. Failed and
 * aborted submissions terminalize the run here.
 */
export async function settleSubmission(
  service: Pick<
    PurchaseImportService,
    "reconcileSettledRun" | "markRunFailed" | "updateAgentProgress"
  >,
  runId: string,
  event: SettledEvent,
): Promise<void> {
  const operationId = `submission-settled:${event.submissionId}`;
  if (event.outcome === "completed") {
    await service.reconcileSettledRun({ runId, operationId });
    return;
  }
  await Promise.all([
    service.markRunFailed({
      runId,
      operationId,
      failureCode: event.outcome === "aborted" ? "flue_aborted" : "flue_failed",
      detail: event.error?.message,
    }),
    service.updateAgentProgress({
      runId,
      eventId: operationId,
      phase: "review",
      detail: event.error?.message ?? `Coordinator ${event.outcome}`,
    }),
  ]);
}
