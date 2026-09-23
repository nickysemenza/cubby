import type { ImportRunId } from "@cubby/schemas/identifiers";

import { getErrorMessage } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { emitTelemetry } from "~/server/telemetry";

export interface AiUsagePort {
  emit: typeof emitTelemetry;
}

const productionAiUsagePort: AiUsagePort = { emit: emitTelemetry };

// `provider`/`model` are open strings: the cookbook extractor walks a model
// ladder priced by its own catalog and reports the cost per call
// (`estimatedCost`); the app-side registry prices the models it calls itself.
export type RecordAiUsageInput = {
  provider: string;
  model: string;
  estimatedCost?: number | null;
  feature: string;
  operation: string;
  /** Every AI call belongs to a run; see `ensureRun`. */
  runId: ImportRunId;
  jobKind?: string | null;
  jobId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Prompt-cache tokens, when the adapter reports them. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  attempt?: number;
  status?: "succeeded" | "failed";
  gatewayLogId?: string | null;
  eventId?: string;
  durationMs: number;
  cacheStatus?: "hit" | "miss" | "none" | null;
  applicationCacheStatus?: "hit" | "miss" | "none" | null;
  entity?: { entityType: string; entityId: string } | null;
};

/** Best-effort AI usage telemetry; never changes the owning AI operation. */
export async function recordAiUsage(
  db: Database,
  input: RecordAiUsageInput,
  port: AiUsagePort = productionAiUsagePort,
): Promise<void> {
  try {
    await port.emit(db, {
      version: 1,
      queueType: "telemetry",
      eventId: input.eventId ?? crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      release: __GIT_COMMIT__,
      type: "ai_usage",
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      runId: input.runId,
      jobKind: input.jobKind ?? null,
      jobId: input.jobId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      attempt: input.attempt ?? 1,
      status: input.status ?? "succeeded",
      gatewayLogId: input.gatewayLogId ?? null,
      durationMs: input.durationMs,
      cacheStatus: input.cacheStatus ?? null,
      applicationCacheStatus: input.applicationCacheStatus ?? null,
      entityType: input.entity?.entityType ?? null,
      entityId: input.entity?.entityId ?? null,
      estimatedCost: input.estimatedCost ?? null,
    });
  } catch (error) {
    console.error("[ai-usage] failed to record usage", {
      error: getErrorMessage(error),
    });
  }
}
