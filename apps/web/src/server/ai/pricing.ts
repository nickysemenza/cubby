import {
  type AiTokenUsage,
  createAiModelPricing,
  estimateAiUsageCost,
} from "@cubby/shared/ai/pricing";
import { createLogger } from "@cubby/worker-tracing";

const log = createLogger("ai/models");

// One live catalog per isolate: a request at a time, a success reused for its
// TTL, and a failure answered as unpriced until its backoff ends.
const pricing = createAiModelPricing({
  onError: (error) => {
    // Never fail the caller: pricing is telemetry, and an unpriced row is
    // already a visible state on /ai-usage.
    log.error("models.dev pricing catalog unavailable", { error });
  },
});

/**
 * What one recorded call cost, or `null` when the model is unknown, the
 * recorded provider disagrees with it, no token counts were reported, or the
 * live catalog cannot price the exact token classes (including while it is
 * unavailable). See `estimateAiUsageCost`.
 */
export async function estimateAiUsageCostUsd(
  provider: string,
  model: string,
  usage: AiTokenUsage,
): Promise<number | null> {
  return estimateAiUsageCost(await pricing.current(), provider, model, usage);
}
