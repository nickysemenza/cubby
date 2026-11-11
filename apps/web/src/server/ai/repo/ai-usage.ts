import {
  type AiUsageRecentFilters,
  type AiUsageRecentInput,
  aiUsageStatus,
} from "@cubby/schemas/ai";
import type { RunId } from "@cubby/schemas/identifiers";
import { imageProcessingAttemptState } from "@cubby/schemas/image-processing";
import { photoRunProcessor } from "@cubby/schemas/photo-run-input";
import {
  type AiCostEvidence,
  aiCostEvidenceSchema,
} from "@cubby/shared/ai/pricing";
import { type AnyColumn, and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  householdDaySql,
  ilikeContains,
  notDeleted,
  uuidArrayParam,
} from "~/server/db/helpers";
import { aiUsage } from "~/server/db/schema";
import { jsonCursor } from "~/server/lib/json-cursor";

/**
 * A failed call that reported no tokens had nothing to price: it is counted
 * separately rather than as an unpriced call.
 */
const failedWithoutUsage = sql`(${aiUsage.status} = ${aiUsageStatus.enum.failed} and ${aiUsage.inputTokens} is null and ${aiUsage.outputTokens} is null and ${aiUsage.cacheReadTokens} is null and ${aiUsage.cacheWriteTokens} is null)`;

export function aiCostSummarySql() {
  return {
    standardCost: sql<number>`coalesce(sum(${aiUsage.standardCost}), 0)`,
    chargedCost: sql<number>`coalesce(sum(${aiUsage.chargedCost}), 0)`,
    standardUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.standardCost} is null and not ${failedWithoutUsage}))::int`,
    chargedUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.chargedCost} is null and not ${failedWithoutUsage}))::int`,
    savings: sql<number>`coalesce(sum(${aiUsage.standardCost} - ${aiUsage.chargedCost}) filter (where ${aiUsage.standardCost} is not null and ${aiUsage.chargedCost} is not null), 0)`,
    comparedCalls: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.standardCost} is not null and ${aiUsage.chargedCost} is not null))::int`,
    count: sql<number>`count(${aiUsage.id})::int`,
    failedWithoutUsageCount: sql<number>`(count(${aiUsage.id}) filter (where ${failedWithoutUsage}))::int`,
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
    .from(aiUsage);
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
    .where(and(...recentFilterConditions(input.filters)))
    .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id))
    .limit(input.limit);

  return rows;
}

const BILLING_REASONS = aiCostEvidenceSchema.shape.billingReason.options;

const summaryRow = z.object({
  day: z.string(),
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  operation: z.string(),
  jobKind: z.string().nullable(),
  jobId: z.string().nullable(),
  cacheStatus: z.enum(["hit", "miss", "none"]).nullable(),
  applicationCacheStatus: z.enum(["hit", "miss", "none"]).nullable(),
  transport: z.enum(["gateway", "chatgpt", "direct", "cache", "unknown"]),
  inputTokens: z.coerce.number(),
  outputTokens: z.coerce.number(),
  cacheReadTokens: z.coerce.number(),
  cacheWriteTokens: z.coerce.number(),
  standardCost: z.coerce.number(),
  chargedCost: z.coerce.number(),
  standardUnpricedCount: z.coerce.number(),
  chargedUnpricedCount: z.coerce.number(),
  savings: z.coerce.number(),
  comparedCalls: z.coerce.number(),
  count: z.coerce.number(),
  failedWithoutUsageCount: z.coerce.number(),
  reasons: z.array(z.boolean().nullable()),
  splitInput: z.coerce.number(),
  splitCacheWrite: z.coerce.number(),
  splitCacheRead: z.coerce.number(),
  splitOutput: z.coerce.number(),
  unsplitCost: z.coerce.number(),
  unsplitCount: z.coerce.number(),
  savedPlan: z.coerce.number(),
  savedSubscriberCredit: z.coerce.number(),
  savedCache: z.coerce.number(),
  savedDiscount: z.coerce.number(),
  durationMs: z.coerce.number(),
});

/**
 * Usage per household day and call shape. A 90-day window holds millions of
 * rows: each row's cost evidence is read once into scalars before grouping,
 * so the aggregate hashes narrow rows. Sorting rows that still carried the
 * evidence spilled over a gigabyte to disk and outlasted the MCP deadline.
 */
export async function summarizeAiUsage(
  db: Database,
  days: number,
  groupBy: "by_feature" | "by_job" = "by_feature",
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // One row per job multiplies a long window's rows by its job count.
  const byJob = groupBy === "by_job";
  const result = await getDb(db).execute<z.input<typeof summaryRow>>(sql`
    WITH usage AS MATERIALIZED (
      SELECT
        ${householdDaySql(aiUsage.createdAt)} AS day,
        ${aiUsage.feature} AS feature,
        ${aiUsage.provider} AS provider,
        ${aiUsage.model} AS model,
        ${aiUsage.operation} AS operation,
        ${aiUsage.jobKind} AS job_kind,
        ${byJob ? aiUsage.jobId : sql`NULL::text`} AS job_id,
        ${aiUsage.cacheStatus} AS cache_status,
        ${aiUsage.applicationCacheStatus} AS application_cache_status,
        ${aiUsage.transport} AS transport,
        ${aiUsage.inputTokens} AS input_tokens,
        ${aiUsage.outputTokens} AS output_tokens,
        ${aiUsage.cacheReadTokens} AS cache_read_tokens,
        ${aiUsage.cacheWriteTokens} AS cache_write_tokens,
        ${aiUsage.standardCost} AS standard_cost,
        ${aiUsage.chargedCost} AS charged_cost,
        ${aiUsage.durationMs} AS duration_ms,
        ${failedWithoutUsage} AS failed_without_usage,
        ${aiUsage.costEvidence}->>'billingReason' AS reason,
        ${aiUsage.costEvidence}#>'{standard,pricingSnapshot,rates}' AS rates,
        ${aiUsage.costEvidence}->'avoidedUsage' AS avoided
      FROM ${aiUsage}
      WHERE ${aiUsage.createdAt} >= ${since}
    )
    SELECT
      to_char(day, 'YYYY-MM-DD') AS "day",
      feature AS "feature",
      provider AS "provider",
      model AS "model",
      operation AS "operation",
      job_kind AS "jobKind",
      job_id AS "jobId",
      cache_status AS "cacheStatus",
      application_cache_status AS "applicationCacheStatus",
      transport AS "transport",
      coalesce(sum(input_tokens), 0)::bigint AS "inputTokens",
      coalesce(sum(output_tokens), 0)::bigint AS "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::bigint AS "cacheReadTokens",
      coalesce(sum(cache_write_tokens), 0)::bigint AS "cacheWriteTokens",
      coalesce(sum(standard_cost), 0)::float8 AS "standardCost",
      coalesce(sum(charged_cost), 0)::float8 AS "chargedCost",
      count(*) FILTER (WHERE standard_cost IS NULL AND NOT failed_without_usage) AS "standardUnpricedCount",
      count(*) FILTER (WHERE charged_cost IS NULL AND NOT failed_without_usage) AS "chargedUnpricedCount",
      coalesce(sum(standard_cost - charged_cost) FILTER (WHERE standard_cost IS NOT NULL AND charged_cost IS NOT NULL), 0)::float8 AS "savings",
      count(*) FILTER (WHERE standard_cost IS NOT NULL AND charged_cost IS NOT NULL) AS "comparedCalls",
      count(*) AS "count",
      count(*) FILTER (WHERE failed_without_usage) AS "failedWithoutUsageCount",
      ARRAY[${sql.join(
        BILLING_REASONS.map((reason) => sql`bool_or(reason = ${reason})`),
        sql`, `,
      )}] AS "reasons",
      ${splitClass("input_tokens", "inputTokens", "input")} AS "splitInput",
      ${splitClass("cache_write_tokens", "cacheWriteTokens", "cache_write")} AS "splitCacheWrite",
      ${splitClass("cache_read_tokens", "cacheReadTokens", "cache_read")} AS "splitCacheRead",
      ${splitClass("output_tokens", "outputTokens", "output")} AS "splitOutput",
      coalesce(sum(standard_cost) FILTER (WHERE rates IS NULL), 0)::float8 AS "unsplitCost",
      count(*) FILTER (WHERE rates IS NULL AND NOT failed_without_usage) AS "unsplitCount",
      ${savedFor("plan")} AS "savedPlan",
      ${savedFor("subscriber_credit")} AS "savedSubscriberCredit",
      ${savedFor("cache")} AS "savedCache",
      ${savedFor("discount")} AS "savedDiscount",
      coalesce(sum(duration_ms), 0)::bigint AS "durationMs"
    FROM usage
    GROUP BY day, feature, provider, model, operation, job_kind, job_id,
      cache_status, application_cache_status, transport
    ORDER BY day DESC, feature, model
  `);
  return z
    .array(summaryRow)
    .parse(result.rows)
    .map(
      ({
        reasons,
        splitInput,
        splitCacheWrite,
        splitCacheRead,
        splitOutput,
        unsplitCost,
        unsplitCount,
        savedPlan,
        savedSubscriberCredit,
        savedCache,
        savedDiscount,
        ...row
      }) => ({
        ...row,
        billingReasons: BILLING_REASONS.filter((_, index) => reasons[index]),
        standardCostSplit: {
          input: splitInput,
          cacheWrite: splitCacheWrite,
          cacheRead: splitCacheRead,
          output: splitOutput,
          unsplitCost,
          unsplitCount,
        },
        savingsByReason: {
          plan: savedPlan,
          subscriberCredit: savedSubscriberCredit,
          cache: savedCache,
          discount: savedDiscount,
        },
      }),
    );
}

/** One token class's standard cost from each row's own rate snapshot. */
function splitClass(
  column: string,
  avoidedKey: string,
  rate: "input" | "cache_write" | "cache_read" | "output",
) {
  return sql`coalesce(sum(coalesce(CASE WHEN avoided IS NOT NULL THEN (avoided->>${avoidedKey})::numeric ELSE ${sql.raw(column)} END, 0) * coalesce((rates->>${rate})::numeric, 0) / 1000000) FILTER (WHERE rates IS NOT NULL), 0)::float8`;
}

const savedFor = (reason: AiCostEvidence["billingReason"]) =>
  sql`coalesce(sum(standard_cost - charged_cost) FILTER (WHERE standard_cost IS NOT NULL AND charged_cost IS NOT NULL AND reason = ${reason}), 0)::float8`;

const runUsageCursor = jsonCursor(
  z.object({ createdAt: z.iso.datetime(), id: z.uuid() }),
  { invalid: "Invalid AI usage cursor" },
);

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
  const cursor = options.cursor ? runUsageCursor.decode(options.cursor) : null;
  const database = getDb(db);
  const scope = sql`WITH RECURSIVE run_scope(id) AS (
    SELECT id FROM "Run" WHERE id = ${runId} AND ${notDeleted("Run")}
    UNION SELECT child.id FROM "Run" child JOIN run_scope parent ON child."parentRunId" = parent.id
      WHERE ${notDeleted("child")}
  ) SELECT id FROM run_scope`;
  // Resolve once: recursive row-count estimates can otherwise turn even the
  // independent membership union into scans of unrelated household history.
  const scopedRuns = await database.execute<{ id: RunId }>(scope);
  const runIds = scopedRuns.rows.map(({ id }) => id);
  // Correlating job membership under an OR re-scans jobs for every unrelated
  // usage row. Build the ID set through run/job indexes first; UNION preserves
  // one contribution when both lineage paths reach the same call.
  const attributed = sql`${aiUsage.id} IN (
    WITH scoped_jobs AS (
      SELECT j.id, j.kind FROM "ImageProcessingJob" j
      WHERE j."runId" = ANY(${uuidArrayParam(runIds)}) AND ${notDeleted("j")}
    )
    SELECT u.id FROM "AiUsage" u
      WHERE u."runId" = ANY(${uuidArrayParam(runIds)})
    UNION
    SELECT u.id FROM scoped_jobs j JOIN "AiUsage" u
      ON u."jobKind" = j.kind AND u."jobId" = j.id::text
    UNION
    SELECT u.id FROM scoped_jobs j
      JOIN "ImageProcessingAttempt" a ON a."jobId" = j.id
      JOIN "AiUsage" u ON u."jobKind" = 'image_processing_attempt'
        AND u."jobId" = a.id::text
  )`;
  const externalCoverage = sql`EXISTS (SELECT 1 FROM "Run" r
    WHERE r.id = ANY(${uuidArrayParam(runIds)}) AND ${notDeleted("r")} AND r.input->>${"processor"} = ${photoRunProcessor.enum.external})`;
  const missingImageCoverage = (allowDeviceCharge: boolean) => sql`EXISTS (
    SELECT 1 FROM "ImageProcessingJob" j
    WHERE ${notDeleted("j")} AND j."runId" = ANY(${uuidArrayParam(runIds)}) AND (
      (NOT EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id)
        AND NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE u."jobKind" = j.kind AND u."jobId" = j.id::text))
      OR EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id
        AND NOT coalesce(${allowDeviceCharge} AND a.executor->>${"kind"} = ${"device"} AND a.state IN (${imageProcessingAttemptState.enum.ready}, ${imageProcessingAttemptState.enum.skipped}), false)
        AND NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE (
          (u."jobKind" = 'image_processing_attempt' AND u."jobId" = a.id::text)
          OR (u."jobKind" = j.kind AND u."jobId" = j.id::text AND u.attempt = a.number)))))
  )`;
  const tokenSum = (column: AnyColumn) =>
    sql<number>`coalesce(sum(${column}), 0)::int`;
  const [totals, rows, coverage, tokensByModel] = await Promise.all([
    database
      .select({
        ...aiCostSummarySql(),
      })
      .from(aiUsage)
      .where(and(attributed)),
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
    }>(
      sql`SELECT
      (${externalCoverage} OR ${missingImageCoverage(true)}) AS "chargedIncomplete",
      (${externalCoverage} OR ${missingImageCoverage(false)}) AS "standardIncomplete"`,
      "objects",
    ),
    database
      .select({
        feature: aiUsage.feature,
        provider: aiUsage.provider,
        model: aiUsage.model,
        inputTokens: tokenSum(aiUsage.inputTokens),
        outputTokens: tokenSum(aiUsage.outputTokens),
        cacheReadTokens: tokenSum(aiUsage.cacheReadTokens),
        cacheWriteTokens: tokenSum(aiUsage.cacheWriteTokens),
      })
      .from(aiUsage)
      .where(and(attributed))
      .groupBy(aiUsage.feature, aiUsage.provider, aiUsage.model)
      .orderBy(aiUsage.feature, aiUsage.provider, aiUsage.model),
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
      failedWithoutUsageCount: 0,
      billingReasons: [],
    }),
    chargedComplete:
      !coverage[0]?.chargedIncomplete &&
      (totals[0]?.chargedUnpricedCount ?? 0) === 0,
    standardComplete:
      !coverage[0]?.standardIncomplete &&
      (totals[0]?.standardUnpricedCount ?? 0) === 0,
    records,
    tokensByModel,
    nextCursor:
      rows.length > limit && last
        ? runUsageCursor.encode({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}
