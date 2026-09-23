import { importRunId, userId } from "@cubby/schemas/identifiers";
import type {
  AiUsageTelemetry,
  McpToolCallTelemetry,
  TelemetryMessageV1,
} from "@cubby/schemas/telemetry";
import { inArray } from "drizzle-orm";
import { match } from "ts-pattern";

import { estimateAiUsageCostUsd } from "~/server/ai/models";
import type { Database } from "~/server/db";
import { aiUsage, importRun, mcpToolCall } from "~/server/db/schema";
import { withTransaction } from "~/server/repo/database-helpers";
import { LEGACY_RUN_ID } from "~/server/runs/ensure-run";

/** Persist a validated telemetry batch atomically and idempotently. */
export async function persistTelemetryMessages(
  db: Database,
  messages: readonly TelemetryMessageV1[],
): Promise<void> {
  if (messages.length === 0) return;

  const mcp: McpToolCallTelemetry[] = [];
  const ai: AiUsageTelemetry[] = [];
  for (const message of messages) {
    match(message)
      .with({ type: "mcp_tool_call" }, (event) => mcp.push(event))
      .with({ type: "ai_usage" }, (event) => ai.push(event))
      .exhaustive();
  }

  await withTransaction(db, async (tx) => {
    // One AI row naming a missing run must not fail the batch (and retry the
    // MCP rows beside it into the DLQ), so unknown runs file under legacy.
    const requestedRuns = [
      ...new Set(ai.flatMap((event) => event.runId ?? [])),
    ].map((id) => importRunId.parse(id));
    const knownRuns = new Set(
      requestedRuns.length === 0
        ? []
        : (
            await tx
              .select({ id: importRun.id })
              .from(importRun)
              .where(inArray(importRun.id, requestedRuns))
          ).map((row): string => row.id),
    );
    if (mcp.length > 0) {
      await tx
        .insert(mcpToolCall)
        .values(
          mcp.map((event) => ({
            id: event.eventId,
            toolName: event.toolName,
            outcome: event.outcome,
            registeredAtCall: event.registeredAtCall,
            surface: event.surface,
            // Absent on a queue message minted before this field existed
            // (see the `.optional()` note on mcpToolCallTelemetrySchema) —
            // those replay as null, same as a tool the extractor can't
            // attribute.
            entity: event.entity ?? null,
            release: event.release,
            occurredAt: new Date(event.occurredAt),
            userId: userId.parse(event.userId),
            clientId: event.clientId,
          })),
        )
        .onConflictDoNothing();
    }

    if (ai.length > 0) {
      await tx
        .insert(aiUsage)
        .values(
          ai.map((event) => ({
            id: event.eventId,
            feature: event.feature,
            provider: event.provider,
            model: event.model,
            operation: event.operation,
            runId:
              event.runId && knownRuns.has(event.runId)
                ? importRunId.parse(event.runId)
                : LEGACY_RUN_ID,
            jobKind: event.jobKind ?? null,
            jobId: event.jobId ?? null,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? null,
            cacheWriteTokens: event.cacheWriteTokens ?? null,
            attempt: event.attempt ?? 1,
            status: event.status ?? "succeeded",
            gatewayLogId: event.gatewayLogId ?? null,
            // The event's own figure wins (the cookbook extractor and Flue
            // provider price every model attempt); the registry prices calls
            // whose provider did not return an exact total.
            estimatedCost:
              event.estimatedCost ??
              estimateAiUsageCostUsd(event.provider, event.model, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens,
                cacheWriteTokens: event.cacheWriteTokens,
              }),
            durationMs: event.durationMs,
            cacheStatus: event.cacheStatus,
            applicationCacheStatus: event.applicationCacheStatus ?? null,
            entityType: event.entityType,
            entityId: event.entityId,
            createdAt: new Date(event.occurredAt),
          })),
        )
        .onConflictDoNothing();
    }
  });
}
