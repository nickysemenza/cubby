import type {
  AiUsageRecentFilters,
  AiUsageRecentInput,
} from "@cubby/schemas/ai";
import type { RunId } from "@cubby/schemas/identifiers";
import { imageProcessingAttemptState } from "@cubby/schemas/image-processing";
import { photoRunProcessor } from "@cubby/schemas/photo-run-input";
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
 * Recorded calls attributed to a Run, its descendants and their image jobs.
 * Indexed membership sets deduplicate calls carrying both run and job lineage.
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
  const scope = sql`WITH RECURSIVE run_scope(id) AS (
    SELECT id FROM "Run" WHERE id = ${runId} AND "deletedAt" IS NULL
    UNION SELECT child.id FROM "Run" child JOIN run_scope parent ON child."parentRunId" = parent.id
      WHERE child."deletedAt" IS NULL
  ) SELECT id FROM run_scope`;
  // Correlating job membership under an OR re-scans jobs for every unrelated
  // usage row. Build the ID set through run/job indexes first; UNION preserves
  // one contribution when both lineage paths reach the same call.
  const attributed = sql`${aiUsage.id} IN (
    WITH scoped_runs AS (${scope}), scoped_jobs AS (
      SELECT j.id, j.kind FROM "ImageProcessingJob" j
      JOIN scoped_runs r ON r.id = j."runId" WHERE j."deletedAt" IS NULL
    )
    SELECT u.id FROM "AiUsage" u JOIN scoped_runs r ON u."runId" = r.id
      WHERE u."deletedAt" IS NULL
    UNION
    SELECT u.id FROM scoped_jobs j JOIN "AiUsage" u
      ON u."jobKind" = j.kind AND u."jobId" = j.id::text
      WHERE u."deletedAt" IS NULL
    UNION
    SELECT u.id FROM scoped_jobs j
      JOIN "ImageProcessingAttempt" a ON a."jobId" = j.id
      JOIN "AiUsage" u ON u."jobKind" = 'image_processing_attempt'
        AND u."jobId" = a.id::text
      WHERE u."deletedAt" IS NULL
  )`;
  const externalCoverage = sql`EXISTS (SELECT 1 FROM "Run" r
    WHERE r.id IN (${scope}) AND r."deletedAt" IS NULL AND r.input->>${"processor"} = ${photoRunProcessor.enum.external})`;
  const missingImageCoverage = (allowDeviceCharge: boolean) => sql`EXISTS (
    SELECT 1 FROM "ImageProcessingJob" j
    WHERE j."deletedAt" IS NULL AND j."runId" IN (${scope}) AND (
      (NOT EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id)
        AND NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE u."deletedAt" IS NULL
          AND u."jobKind" = j.kind AND u."jobId" = j.id::text))
      OR EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id
        AND NOT coalesce(${allowDeviceCharge} AND a.executor->>${"kind"} = ${"device"} AND a.state IN (${imageProcessingAttemptState.enum.ready}, ${imageProcessingAttemptState.enum.skipped}), false)
        AND NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE u."deletedAt" IS NULL AND (
          (u."jobKind" = 'image_processing_attempt' AND u."jobId" = a.id::text)
          OR (u."jobKind" = j.kind AND u."jobId" = j.id::text AND u.attempt = a.number)))))
  )`;
  const [totals, rows, coverage] = await Promise.all([
    database
      .select({
        ...aiCostSummarySql(),
      })
      .from(aiUsage)
      .where(and(attributed, notDeleted(aiUsage))),
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
          attributed,
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
    database.execute<{
      chargedIncomplete: boolean;
      standardIncomplete: boolean;
    }>(sql`SELECT
      (${externalCoverage} OR ${missingImageCoverage(true)}) AS "chargedIncomplete",
      (${externalCoverage} OR ${missingImageCoverage(false)}) AS "standardIncomplete"`),
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
    chargedComplete:
      !coverage.rows[0]?.chargedIncomplete &&
      (totals[0]?.chargedUnpricedCount ?? 0) === 0,
    standardComplete:
      !coverage.rows[0]?.standardIncomplete &&
      (totals[0]?.standardUnpricedCount ?? 0) === 0,
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
