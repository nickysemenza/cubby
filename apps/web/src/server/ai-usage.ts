import type { SupportedAiModelRef } from "~/server/ai/models";
import type { Database } from "~/server/db";
import { emitTelemetry } from "~/server/telemetry";

export type RecordAiUsageInput = SupportedAiModelRef & {
  feature: string;
  operation: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs: number;
  cacheStatus?: "hit" | "miss" | "none" | null;
  entity?: { entityType: string; entityId: string } | null;
  batchId?: string | null;
};

/** Best-effort AI usage telemetry; never changes the owning AI operation. */
export async function recordAiUsage(
  db: Database,
  input: RecordAiUsageInput,
): Promise<void> {
  try {
    await emitTelemetry(db, {
      version: 1,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      release: __GIT_COMMIT__,
      type: "ai_usage",
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      durationMs: input.durationMs,
      cacheStatus: input.cacheStatus ?? null,
      entityType: input.entity?.entityType ?? null,
      entityId: input.entity?.entityId ?? null,
      batchId: input.batchId ?? null,
    });
  } catch (error) {
    console.error("[ai-usage] failed to record usage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
