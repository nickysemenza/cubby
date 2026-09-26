import type { RunId } from "@cubby/schemas/identifiers";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

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
      applicationCacheStatus: aiUsage.applicationCacheStatus,
      entityKind: aiUsage.entityKind,
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
      applicationCacheStatus: aiUsage.applicationCacheStatus,
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
      aiUsage.applicationCacheStatus,
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

const runUsageCursor = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

const encodeRunUsageCursor = (value: z.infer<typeof runUsageCursor>) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decodeRunUsageCursor = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return runUsageCursor.parse(JSON.parse(atob(padded)));
};

/**
 * Every AI call one Run grouped, newest first, with the full-run subtotal.
 * Any run purpose: import runs and AI-only runs (no member party) alike.
 */
export async function listAiUsageForRun(
  db: Database,
  runId: RunId,
  options: { cursor?: string | null; limit?: number } = {},
) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 25);
  const cursor = options.cursor ? decodeRunUsageCursor(options.cursor) : null;
  const database = getDb(db);
  const [totals, rows] = await Promise.all([
    database
      .select({
        pricedSubtotal: sql<number>`coalesce(sum(${aiUsage.estimatedCost}) filter (where ${aiUsage.estimatedCost} is not null), 0)`,
        unpricedCount: sql<number>`(count(*) filter (where ${aiUsage.estimatedCost} is null and ${aiUsage.status} = 'succeeded'))::int`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.runId, runId), notDeleted(aiUsage))),
    database
      .select({
        id: aiUsage.id,
        createdAt: aiUsage.createdAt,
        feature: aiUsage.feature,
        operation: aiUsage.operation,
        provider: aiUsage.provider,
        model: aiUsage.model,
        inputTokens: aiUsage.inputTokens,
        outputTokens: aiUsage.outputTokens,
        cacheReadTokens: aiUsage.cacheReadTokens,
        cacheWriteTokens: aiUsage.cacheWriteTokens,
        attempt: aiUsage.attempt,
        status: aiUsage.status,
        gatewayLogId: aiUsage.gatewayLogId,
        cacheStatus: aiUsage.cacheStatus,
        applicationCacheStatus: aiUsage.applicationCacheStatus,
        durationMs: aiUsage.durationMs,
        estimatedCost: aiUsage.estimatedCost,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.runId, runId),
          notDeleted(aiUsage),
          cursor
            ? or(
                lt(aiUsage.createdAt, new Date(cursor.createdAt)),
                and(
                  eq(aiUsage.createdAt, new Date(cursor.createdAt)),
                  lt(aiUsage.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id))
      .limit(limit + 1),
  ]);
  const records = rows.slice(0, limit);
  const last = records.at(-1);
  return {
    pricedSubtotal: totals[0]?.pricedSubtotal ?? 0,
    unpricedCount: totals[0]?.unpricedCount ?? 0,
    records,
    nextCursor:
      rows.length > limit && last
        ? encodeRunUsageCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}
