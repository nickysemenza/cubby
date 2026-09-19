import { userId } from "@cubby/schemas/identifiers";
import type {
  AiUsageTelemetry,
  McpToolCallTelemetry,
  TelemetryMessageV1,
} from "@cubby/schemas/telemetry";
import { match } from "ts-pattern";

import { estimateAiUsageCostUsd } from "~/server/ai/models";
import type { Database } from "~/server/db";
import { aiUsage, mcpToolCall } from "~/server/db/schema";
import { withTransaction } from "~/server/repo/database-helpers";

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
            jobKind: event.jobKind ?? null,
            jobId: event.jobId ?? null,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            // The event's own figure wins (the cookbook extractor prices
            // every model it calls); the registry prices the rest. Cache
            // token counts have no column of their own — they only reach the
            // ledger through this estimate.
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
            entityType: event.entityType,
            entityId: event.entityId,
            createdAt: new Date(event.occurredAt),
          })),
        )
        .onConflictDoNothing();
    }
  });
}
