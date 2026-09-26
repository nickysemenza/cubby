import type { RunId } from "@cubby/schemas/identifiers";
import type { ChatMiddleware } from "@tanstack/ai";

import { recordAiUsage } from "~/server/ai-usage";
import type { SupportedAiModelRef } from "~/server/ai/models";
import type { Database } from "~/server/db";

export type AiGatewayUsageContext = SupportedAiModelRef & {
  db: Database;
  /** Every AI call belongs to a run; see `ensureRun`. */
  runId: RunId;
  feature: string;
  operation: string;
  jobKind?: string | null;
  jobId?: string | null;
  cacheStatus?: "hit" | "miss" | "none";
  applicationCacheStatus?: "hit" | "miss" | "none";
  entity?: { entityType: string; entityId: string } | null;
};

export function aiGatewayUsageMiddleware(
  usageContext?: AiGatewayUsageContext,
): ChatMiddleware[] {
  if (!usageContext) return [];

  return [
    {
      name: "cubby-ai-gateway-usage",
      async onFinish(_ctx, info) {
        const usage = info.usage;
        const { db, ...usageInput } = usageContext;
        await recordAiUsage(db, {
          ...usageInput,
          inputTokens: usage?.promptTokens ?? null,
          outputTokens: usage?.completionTokens ?? null,
          durationMs: Math.max(0, Math.round(info.duration)),
          applicationCacheStatus: usageContext.applicationCacheStatus ?? "none",
        });
      },
    },
  ];
}
