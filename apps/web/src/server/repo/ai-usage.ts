import { desc, sql } from "drizzle-orm";

import { estimateAiUsageCostUsd } from "~/server/ai/models";
import type { Database } from "~/server/db";
import { aiUsage } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

export async function listRecentAiUsage(db: Database, limit: number) {
  const rows = await getDb(db)
    .select({
      id: aiUsage.id,
      feature: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      operation: aiUsage.operation,
      jobKind: aiUsage.jobKind,
      jobId: aiUsage.jobId,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      cacheReadTokens: aiUsage.cacheReadTokens,
      cacheWriteTokens: aiUsage.cacheWriteTokens,
      attempt: aiUsage.attempt,
      status: aiUsage.status,
      gatewayLogId: aiUsage.gatewayLogId,
      estimatedCost: aiUsage.estimatedCost,
      durationMs: aiUsage.durationMs,
      cacheStatus: aiUsage.cacheStatus,
      entityType: aiUsage.entityType,
      entityId: aiUsage.entityId,
      createdAt: aiUsage.createdAt,
    })
    .from(aiUsage)
    .where(notDeleted(aiUsage))
    .orderBy(desc(aiUsage.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    estimatedCost:
      row.estimatedCost ??
      estimateAiUsageCostUsd(row.provider, row.model, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
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
      jobKind: aiUsage.jobKind,
      jobId: aiUsage.jobId,
      cacheStatus: aiUsage.cacheStatus,
      count: sql<number>`count(*)::int`,
      // bigint to avoid int4 overflow on cumulative token/duration sums; the pg
      // driver returns bigint as a string, so these are Number()-coerced below.
      inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<string>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::bigint`,
      cacheWriteTokens: sql<string>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::bigint`,
      estimatedCost: sql<number | null>`sum(${aiUsage.estimatedCost})`,
      unpricedInputTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.inputTokens} else 0 end), 0)::bigint`,
      unpricedOutputTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.outputTokens} else 0 end), 0)::bigint`,
      unpricedCacheReadTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.cacheReadTokens} else 0 end), 0)::bigint`,
      unpricedCacheWriteTokens: sql<string>`coalesce(sum(case when ${aiUsage.estimatedCost} is null then ${aiUsage.cacheWriteTokens} else 0 end), 0)::bigint`,
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
      aiUsage.jobKind,
      aiUsage.jobId,
      aiUsage.cacheStatus,
    )
    .orderBy(sql`${usageDayGroup} DESC`, aiUsage.feature, aiUsage.model);

  return rows.map(
    ({
      unpricedInputTokens,
      unpricedOutputTokens,
      unpricedCacheReadTokens,
      unpricedCacheWriteTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      durationMs,
      ...row
    }) => {
      const computedUnstoredCost = estimateAiUsageCostUsd(
        row.provider,
        row.model,
        {
          inputTokens: Number(unpricedInputTokens),
          outputTokens: Number(unpricedOutputTokens),
          cacheReadTokens: Number(unpricedCacheReadTokens),
          cacheWriteTokens: Number(unpricedCacheWriteTokens),
        },
      );
      return {
        ...row,
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        cacheReadTokens: Number(cacheReadTokens),
        cacheWriteTokens: Number(cacheWriteTokens),
        durationMs: Number(durationMs),
        estimatedCost:
          row.estimatedCost == null
            ? computedUnstoredCost
            : row.estimatedCost + (computedUnstoredCost ?? 0),
      };
    },
  );
}
