import { observe, type FlueEvent } from "@flue/runtime";

import { purchaseImportService, type AgentUsageEvent } from "./service";

const INSTANCE_PREFIX = "import-run:";
const attempts = new Map<string, number>();

function runIdFor(event: FlueEvent): string | undefined {
  return event.instanceId?.startsWith(INSTANCE_PREFIX)
    ? event.instanceId.slice(INSTANCE_PREFIX.length)
    : undefined;
}

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

export function installPurchaseImportTelemetry(): void {
  observe(async (event, context) => {
    const runId = runIdFor(event);
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
    if (event.outcome === "completed") return;
    await Promise.all([
      service.markRunFailed({
        runId,
        operationId: `submission-settled:${event.submissionId}`,
        failureCode:
          event.outcome === "aborted" ? "flue_aborted" : "flue_failed",
        detail: event.error?.message,
      }),
      service.updateAgentProgress({
        runId,
        eventId: `submission-settled:${event.submissionId}`,
        phase: "review",
        detail: event.error?.message ?? `Coordinator ${event.outcome}`,
      }),
    ]);
  });
}
