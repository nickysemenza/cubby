import type { RunId } from "@cubby/schemas/identifiers";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import { getErrorMessage } from "@cubby/shared";
import { accountAiUsage, type AiCostEvidence } from "@cubby/shared/ai/pricing";
import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import { emitTelemetry } from "~/server/observability/telemetry";

import { snapshotAiUsagePrice } from "./pricing";

const log = createLogger("ai-usage");

export interface AiUsagePort {
  emit: typeof emitTelemetry;
  snapshot?: typeof snapshotAiUsagePrice;
}

const productionAiUsagePort: AiUsagePort = {
  emit: emitTelemetry,
  snapshot: snapshotAiUsagePrice,
};

// Open provider/model strings retain external extractor usage; the registry
// captures the standard quote, and supplied charged estimates keep their evidence.
export type RecordAiUsageInput = {
  provider: string;
  model: string;
  standardCost?: number | null;
  chargedCost?: number | null;
  costEvidence?: AiCostEvidence | null;
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
   * billed, so charged cost is zero; comparison evidence and caller cache stay.
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
 * replay made no model call (zero attempts and charged cost), and neither ChatGPT plan
 * usage nor a gateway response-cache hit is API spend — both keep their
 * attempts, transport, and token evidence.
 */
async function usageBilling(
  input: RecordAiUsageInput,
  snapshotPrice: NonNullable<AiUsagePort["snapshot"]>,
) {
  const replayed = input.transport === "cache";
  const reason =
    input.transport === "chatgpt"
      ? "plan"
      : replayed || input.gatewayCacheStatus === "hit"
        ? "cache"
        : (input.costEvidence?.billingReason ?? "standard");
  const gatewayReplay = input.gatewayCacheStatus === "hit";
  const positiveTokens = [
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
  ].some((tokens) => tokens != null && tokens > 0);
  // A rate snapshot calculated from zero placeholders is not evidence of an inference.
  const retainedComparison =
    input.standardCost != null &&
    input.costEvidence?.standard?.pricingSnapshot != null &&
    (!gatewayReplay ||
      positiveTokens ||
      input.standardCost !== 0 ||
      input.costEvidence.standard.source === "provider_reported");
  const supportedComparison = replayed
    ? retainedComparison
    : !gatewayReplay || positiveTokens || retainedComparison;
  const quotableTokens = (!replayed && !gatewayReplay) || positiveTokens;
  const snapshot =
    supportedComparison && quotableTokens
      ? await snapshotPrice(input.provider, input.model, input)
      : null;
  const standardCost =
    snapshot?.amount ??
    (supportedComparison ? (input.standardCost ?? null) : null);
  const fallback: AiCostEvidence["standard"] =
    input.costEvidence?.standard ??
    (standardCost === null ? null : { source: "estimate" as const });
  const standard =
    snapshot?.evidence ??
    (standardCost === null || !fallback
      ? null
      : {
          ...fallback,
          pricingSource: fallback.pricingSource ?? ("caller" as const),
        });
  return {
    attempt: replayed ? 0 : (input.attempt ?? 1),
    ...accountAiUsage(
      { amount: standardCost, evidence: standard },
      {
        ...input.costEvidence,
        billingReason: reason,
        chargedCost: input.chargedCost,
      },
      input,
    ),
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
      ...(await usageBilling(input, port.snapshot ?? snapshotAiUsagePrice)),
    });
  } catch (error) {
    log.error("failed to record usage", {
      error: getErrorMessage(error),
    });
  }
}
