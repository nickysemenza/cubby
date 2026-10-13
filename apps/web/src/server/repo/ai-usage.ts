import type {
  AiUsageRecentFilters,
  AiUsageRecentInput,
  AiUsageTransport,
} from "@cubby/schemas/ai";
import type { RunId } from "@cubby/schemas/identifiers";
import type { AiCostEvidence } from "@cubby/shared/ai/pricing";
import { encodeBase64Url, decodeBase64UrlText } from "@cubby/shared/base64";
import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { aiUsage } from "~/server/db/schema";
import {
  getDb,
  householdDaySql,
  ilikeContains,
  notDeleted,
} from "~/server/repo/database-helpers";

/**
 * A `cache` replay made no model call and ChatGPT plan usage is not API
 * spend: neither is ever priced from its tokens, including rows recorded
 * before the writer stored their zero cost.
 */
export function isUnbilledAiTransport(transport: AiUsageTransport): boolean {
  return transport === "cache" || transport === "chatgpt";
}

export function aiCostSummarySql() {
  return {
    standardCost: sql<number>`coalesce(sum(${aiUsage.standardCost}), 0)`,
    chargedCost: sql<number>`coalesce(sum(${aiUsage.chargedCost}), 0)`,
    standardUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.standardCost} is null))::int`,
    chargedUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.chargedCost} is null))::int`,
    savings: sql<number>`coalesce(sum(${aiUsage.standardCost} - ${aiUsage.chargedCost}) filter (where ${aiUsage.standardCost} is not null and ${aiUsage.chargedCost} is not null), 0)`,
    comparedCalls: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.standardCost} is not null and ${aiUsage.chargedCost} is not null))::int`,
    count: sql<number>`count(${aiUsage.id})::int`,
    billingReasons: sql<
      AiCostEvidence["billingReason"][]
    >`coalesce(jsonb_agg(distinct ${aiUsage.costEvidence}->>'billingReason') filter (where ${aiUsage.costEvidence}->>'billingReason' is not null), '[]'::jsonb)`,
  };
}

function recentFilterConditions(filters: AiUsageRecentFilters = {}) {
  const pattern = filters.query ? ilikeContains(filters.query) : null;
  return [
    filters.transport ? eq(aiUsage.transport, filters.transport) : undefined,
    filters.status ? eq(aiUsage.status, filters.status) : undefined,
    filters.provider ? eq(aiUsage.provider, filters.provider) : undefined,
    filters.model ? eq(aiUsage.model, filters.model) : undefined,
    filters.feature ? eq(aiUsage.feature, filters.feature) : undefined,
    pattern
      ? or(
          ilike(aiUsage.feature, pattern),
          ilike(aiUsage.model, pattern),
          ilike(aiUsage.operation, pattern),
        )
      : undefined,
  ];
}

/** Full-history filter choices, independent of summary windows and row limits. */
export async function listAiUsageFilterOptions(db: Database) {
  const rows = await getDb(db)
    .selectDistinct({
      provider: aiUsage.provider,
      model: aiUsage.model,
      feature: aiUsage.feature,
    })
    .from(aiUsage)
    .where(notDeleted(aiUsage));
  const values = (key: keyof (typeof rows)[number]) =>
    [...new Set(rows.map((row) => row[key]))].sort((a, b) =>
      a.localeCompare(b),
    );
  return {
    provider: values("provider"),
    model: values("model"),
    feature: values("feature"),
  };
}

/** The newest calls matching `filters`; filters apply before `limit`. */
export async function listRecentAiUsage(
  db: Database,
  input: AiUsageRecentInput,
) {
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
      standardCost: aiUsage.standardCost,
      costEvidence: aiUsage.costEvidence,
      chargedCost: aiUsage.chargedCost,
      durationMs: aiUsage.durationMs,
      cacheStatus: aiUsage.cacheStatus,
      applicationCacheStatus: aiUsage.applicationCacheStatus,
      transport: aiUsage.transport,
      entityKind: aiUsage.entityKind,
      entityId: aiUsage.entityId,
      createdAt: aiUsage.createdAt,
    })
    .from(aiUsage)
    .where(and(notDeleted(aiUsage), ...recentFilterConditions(input.filters)))
    .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id))
    .limit(input.limit);

  return rows;
}

export async function summarizeAiUsage(db: Database, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const usageDayGroup = householdDaySql(aiUsage.createdAt);
  const usageDay = sql<string>`to_char(${usageDayGroup}, 'YYYY-MM-DD')`;

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
      transport: aiUsage.transport,
      // bigint to avoid int4 overflow on cumulative token/duration sums; the pg
      // driver returns bigint as a string, so these are Number()-coerced below.
      inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<string>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::bigint`,
      cacheWriteTokens: sql<string>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::bigint`,
      ...aiCostSummarySql(),
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
      aiUsage.transport,
    )
    .orderBy(sql`${usageDayGroup} DESC`, aiUsage.feature, aiUsage.model);

  return rows.map(
    ({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      durationMs,
      ...row
    }) => ({
      ...row,
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
      cacheReadTokens: Number(cacheReadTokens),
      cacheWriteTokens: Number(cacheWriteTokens),
      durationMs: Number(durationMs),
    }),
  );
}

const runUsageCursor = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

const encodeRunUsageCursor = (value: z.infer<typeof runUsageCursor>) =>
  encodeBase64Url(JSON.stringify(value));

const decodeRunUsageCursor = (value: string) =>
  runUsageCursor.parse(JSON.parse(decodeBase64UrlText(value)));

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
        ...aiCostSummarySql(),
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
        transport: aiUsage.transport,
        durationMs: aiUsage.durationMs,
        standardCost: aiUsage.standardCost,
        costEvidence: aiUsage.costEvidence,
        chargedCost: aiUsage.chargedCost,
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
    ...(totals[0] ?? {
      standardCost: 0,
      chargedCost: 0,
      standardUnpricedCount: 0,
      chargedUnpricedCount: 0,
      savings: 0,
      comparedCalls: 0,
      count: 0,
      billingReasons: [],
    }),
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
