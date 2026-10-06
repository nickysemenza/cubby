import type { RunId } from "@cubby/schemas/identifiers";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import { createLogger } from "@cubby/worker-tracing";

import { getErrorMessage } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { emitTelemetry } from "~/server/telemetry";

const log = createLogger("ai-usage");

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
  runId: RunId;
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
  /**
   * The gateway's own response-cache verdict. Not persisted: a `hit` was not
   * billed, so it only zeroes the cost; `cacheStatus` stays the caller's.
   */
  gatewayCacheStatus?: "hit" | "miss" | null;
  eventId?: string;
  durationMs: number;
  /** The *caller's* own cache (AiAnalysis, a flow artifact), never the gateway's. */
  cacheStatus?: "hit" | "miss" | "none" | null;
  applicationCacheStatus?: "hit" | "miss" | "none" | null;
  /** What carried the call; `unknown` only when the caller has no evidence. */
  transport: AiUsageTransport;
  entity?: { entityKind: string; entityId: string } | null;
};

/**
 * Best-effort AI usage telemetry; never changes the owning AI operation.
 *
 * Every row passes through here, so the accounting rules live here: a `cache`
 * replay made no model call (zero attempts, no cost), and neither ChatGPT plan
 * usage nor a gateway response-cache hit is API spend — both keep their
 * attempts, transport, and token evidence.
 */
function usageBilling(input: RecordAiUsageInput) {
  const replayed = input.transport === "cache";
  const unbilled =
    replayed ||
    input.transport === "chatgpt" ||
    input.gatewayCacheStatus === "hit";
  return {
    attempt: replayed ? 0 : (input.attempt ?? 1),
    estimatedCost: unbilled ? 0 : (input.estimatedCost ?? null),
  };
}

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
      status: input.status ?? "succeeded",
      gatewayLogId: input.gatewayLogId ?? null,
      durationMs: input.durationMs,
      cacheStatus: input.cacheStatus ?? null,
      applicationCacheStatus: input.applicationCacheStatus ?? null,
      transport: input.transport,
      entityKind: input.entity?.entityKind ?? null,
      entityId: input.entity?.entityId ?? null,
      ...usageBilling(input),
    });
  } catch (error) {
    log.error("failed to record usage", {
      error: getErrorMessage(error),
    });
  }
}
