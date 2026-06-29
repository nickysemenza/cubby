import { desc, isNull, sql } from "drizzle-orm";
import {
  estimateAiUsageCostUsd,
  type SupportedAiModelRef,
} from "~/server/ai/models";
import type { Database } from "~/server/db";
import { aiUsage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

type RecordAiUsageInput = SupportedAiModelRef & {
  feature: string;
  operation: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs: number;
  cacheStatus?: "hit" | "miss" | "none" | null;
  entity?: { entityType: string; entityId: string } | null;
  batchId?: string | null;
};

export async function recordAiUsage(
  db: Database,
  input: RecordAiUsageInput,
): Promise<void> {
  try {
    await getDb(db)
      .insert(aiUsage)
      .values({
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        estimatedCost: estimateAiUsageCostUsd(input.provider, input.model, {
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
        }),
        durationMs: input.durationMs,
        cacheStatus: input.cacheStatus ?? null,
        entityType: input.entity?.entityType ?? null,
        entityId: input.entity?.entityId ?? null,
        batchId: input.batchId ?? null,
      });
  } catch (error) {
    console.error("[ai-usage] failed to record usage", error);
  }
}

export async function listRecentAiUsage(db: Database, limit: number) {
  const rows = await getDb(db)
    .select({
      id: aiUsage.id,
      feature: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      operation: aiUsage.operation,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      estimatedCost: aiUsage.estimatedCost,
      durationMs: aiUsage.durationMs,
      cacheStatus: aiUsage.cacheStatus,
      entityType: aiUsage.entityType,
      entityId: aiUsage.entityId,
      batchId: aiUsage.batchId,
      createdAt: aiUsage.createdAt,
    })
    .from(aiUsage)
    .where(isNull(aiUsage.deletedAt))
    .orderBy(desc(aiUsage.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    estimatedCost:
      row.estimatedCost ??
      estimateAiUsageCostUsd(row.provider, row.model, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      }),
  }));
}

export async function summarizeAiUsage(db: Database, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const usageDay = sql<string>`to_char(date_trunc('day', ${aiUsage.createdAt}), 'YYYY-MM-DD')`;
  const usageDayGroup = sql`date_trunc('day', ${aiUsage.createdAt})`;

  const rows = await getDb(db)
    .select({
      day: usageDay,
      feature: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      operation: aiUsage.operation,
      cacheStatus: aiUsage.cacheStatus,
      count: sql<number>`count(*)::int`,
      // bigint to avoid int4 overflow on cumulative token/duration sums; the pg
      // driver returns bigint as a string, so these are Number()-coerced below.
      inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      estimatedCost: sql<number | null>`sum(${aiUsage.estimatedCost})`,
      unpricedInputTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.inputTokens} else 0 end), 0)::bigint`,
      unpricedOutputTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.outputTokens} else 0 end), 0)::bigint`,
      durationMs: sql<string>`coalesce(sum(${aiUsage.durationMs}), 0)::bigint`,
    })
    .from(aiUsage)
    .where(
      sql`${aiUsage.deletedAt} IS NULL AND ${aiUsage.createdAt} >= ${since}`,
    )
    .groupBy(
      usageDayGroup,
      aiUsage.feature,
      aiUsage.provider,
      aiUsage.model,
      aiUsage.operation,
      aiUsage.cacheStatus,
    )
    .orderBy(sql`${usageDayGroup} DESC`, aiUsage.feature, aiUsage.model);

  return rows.map(
    ({
      unpricedInputTokens,
      unpricedOutputTokens,
      inputTokens,
      outputTokens,
      durationMs,
      ...row
    }) => {
      const computedUnstoredCost = estimateAiUsageCostUsd(
        row.provider,
        row.model,
        {
          inputTokens: Number(unpricedInputTokens),
          outputTokens: Number(unpricedOutputTokens),
        },
      );
      return {
        ...row,
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        durationMs: Number(durationMs),
        estimatedCost:
          row.estimatedCost == null
            ? computedUnstoredCost
            : row.estimatedCost + (computedUnstoredCost ?? 0),
      };
    },
  );
}
