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

/**
 * What a charge-only reader needs. A list of Runs sums thousands of calls per
 * Run, so it must not pay for the evidence and standard-price aggregates
 * `aiCostSummarySql` adds.
 */
export function aiChargedCostSql() {
  return {
    chargedCost: sql<number>`coalesce(sum(${aiUsage.chargedCost}), 0)`,
    chargedUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.chargedCost} is null and not ${failedWithoutUsage}))::int`,
  };
}

export function aiCostSummarySql() {
  return {
    ...aiChargedCostSql(),
    standardCost: sql<number>`coalesce(sum(${aiUsage.standardCost}), 0)`,
    standardUnpricedCount: sql<number>`(count(${aiUsage.id}) filter (where ${aiUsage.standardCost} is null and not ${failedWithoutUsage}))::int`,
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
  const database = getDb(db);
  const sorted = (values: readonly string[]) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const [features, models, providers] = await Promise.all([
    database.selectDistinct({ feature: aiUsage.feature }).from(aiUsage),
    database.selectDistinct({ model: aiUsage.model }).from(aiUsage),
    // Newest provider per model, then the distinct set. (model, createdAt) is indexed.
    database.execute<{ provider: string }>(sql`
      SELECT DISTINCT provider FROM (
        SELECT DISTINCT ON (${aiUsage.model}) ${aiUsage.provider} AS provider
        FROM ${aiUsage}
        ORDER BY ${aiUsage.model}, ${aiUsage.createdAt} DESC
      ) model_provider
    `),
  ]);
  return {
    provider: sorted(providers.rows.map((row) => row.provider)),
    model: sorted(models.map((row) => row.model)),
    feature: sorted(features.map((row) => row.feature)),
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

const usageRates = sql`${aiUsage.costEvidence}#>'{standard,pricingSnapshot,rates}'`;
const usageAvoided = sql`${aiUsage.costEvidence}->'avoidedUsage'`;
const usageReason = sql`${aiUsage.costEvidence}->>'billingReason'`;

/**
 * Usage per household day and call shape. Group keys stay scalars. Rate and
 * avoided JSON is read inside each aggregate, not carried through a CTE, so
 * the hash does not spill those documents to disk.
 */
export async function summarizeAiUsage(
  db: Database,
  days: number,
  groupBy: "by_feature" | "by_job" = "by_feature",
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // One row per job multiplies a long window's rows by its job count.
  const byJob = groupBy === "by_job";
  const day = householdDaySql(aiUsage.createdAt);
  const jobId = byJob ? aiUsage.jobId : sql`NULL::text`;
  const result = await getDb(db).execute<z.input<typeof summaryRow>>(sql`
    SELECT
      to_char(${day}, 'YYYY-MM-DD') AS "day",
      ${aiUsage.feature} AS "feature",
      ${aiUsage.provider} AS "provider",
      ${aiUsage.model} AS "model",
      ${aiUsage.operation} AS "operation",
      ${aiUsage.jobKind} AS "jobKind",
      ${jobId} AS "jobId",
      ${aiUsage.cacheStatus} AS "cacheStatus",
      ${aiUsage.applicationCacheStatus} AS "applicationCacheStatus",
      ${aiUsage.transport} AS "transport",
      coalesce(sum(${aiUsage.inputTokens}), 0)::bigint AS "inputTokens",
      coalesce(sum(${aiUsage.outputTokens}), 0)::bigint AS "outputTokens",
      coalesce(sum(${aiUsage.cacheReadTokens}), 0)::bigint AS "cacheReadTokens",
      coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::bigint AS "cacheWriteTokens",
      coalesce(sum(${aiUsage.standardCost}), 0)::float8 AS "standardCost",
      coalesce(sum(${aiUsage.chargedCost}), 0)::float8 AS "chargedCost",
      count(*) FILTER (WHERE ${aiUsage.standardCost} IS NULL AND NOT ${failedWithoutUsage}) AS "standardUnpricedCount",
      count(*) FILTER (WHERE ${aiUsage.chargedCost} IS NULL AND NOT ${failedWithoutUsage}) AS "chargedUnpricedCount",
      coalesce(sum(${aiUsage.standardCost} - ${aiUsage.chargedCost}) FILTER (WHERE ${aiUsage.standardCost} IS NOT NULL AND ${aiUsage.chargedCost} IS NOT NULL), 0)::float8 AS "savings",
      count(*) FILTER (WHERE ${aiUsage.standardCost} IS NOT NULL AND ${aiUsage.chargedCost} IS NOT NULL) AS "comparedCalls",
      count(*) AS "count",
      count(*) FILTER (WHERE ${failedWithoutUsage}) AS "failedWithoutUsageCount",
      ARRAY[${sql.join(
        BILLING_REASONS.map(
          (reason) => sql`bool_or(${usageReason} = ${reason})`,
        ),
        sql`, `,
      )}] AS "reasons",
      ${splitClass(aiUsage.inputTokens, "inputTokens", "input")} AS "splitInput",
      ${splitClass(aiUsage.cacheWriteTokens, "cacheWriteTokens", "cache_write")} AS "splitCacheWrite",
      ${splitClass(aiUsage.cacheReadTokens, "cacheReadTokens", "cache_read")} AS "splitCacheRead",
      ${splitClass(aiUsage.outputTokens, "outputTokens", "output")} AS "splitOutput",
      coalesce(sum(${aiUsage.standardCost}) FILTER (WHERE ${usageRates} IS NULL), 0)::float8 AS "unsplitCost",
      count(*) FILTER (WHERE ${usageRates} IS NULL AND NOT ${failedWithoutUsage}) AS "unsplitCount",
      ${savedFor("plan")} AS "savedPlan",
      ${savedFor("subscriber_credit")} AS "savedSubscriberCredit",
      ${savedFor("cache")} AS "savedCache",
      ${savedFor("discount")} AS "savedDiscount",
      coalesce(sum(${aiUsage.durationMs}), 0)::bigint AS "durationMs"
    FROM ${aiUsage}
    WHERE ${aiUsage.createdAt} >= ${since}
    GROUP BY ${day}, ${aiUsage.feature}, ${aiUsage.provider}, ${aiUsage.model},
      ${aiUsage.operation}, ${aiUsage.jobKind}, ${jobId}, ${aiUsage.cacheStatus},
      ${aiUsage.applicationCacheStatus}, ${aiUsage.transport}
    ORDER BY ${day} DESC, ${aiUsage.feature}, ${aiUsage.model}
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
  column: AnyColumn,
  avoidedKey: string,
  rate: "input" | "cache_write" | "cache_read" | "output",
) {
  return sql`coalesce(sum(coalesce(CASE WHEN ${usageAvoided} IS NOT NULL THEN (${usageAvoided}->>${avoidedKey})::numeric ELSE ${column} END, 0) * coalesce((${usageRates}->>${rate})::numeric, 0) / 1000000) FILTER (WHERE ${usageRates} IS NOT NULL), 0)::float8`;
}

const savedFor = (reason: AiCostEvidence["billingReason"]) =>
  sql`coalesce(sum(${aiUsage.standardCost} - ${aiUsage.chargedCost}) FILTER (WHERE ${aiUsage.standardCost} IS NOT NULL AND ${aiUsage.chargedCost} IS NOT NULL AND ${usageReason} = ${reason}), 0)::float8`;

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
