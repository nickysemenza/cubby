import {
  activityAttempt,
  activityDetailOutput,
  activityDevicesOutput,
  activityEvent,
  activityEventsOutput,
  activityListOutput,
  activityRun,
  activitySubmissionOutput,
  imageAnalysisHistoryOutput,
  type ActivityListInput,
} from "@cubby/schemas/activity";
import {
  imageDescriptionAnalysis,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { imageProcessingAttempt } from "~/server/db/image-processing-schema";
import { aiAnalysis, aiUsage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  getImageProcessingReadProjection,
} from "./image-processing";

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string() });

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    return cursorSchema.parse(JSON.parse(atob(value)));
  } catch {
    throw new Error("Invalid activity cursor");
  }
}

function encodeCursor(at: string, id: string) {
  return btoa(JSON.stringify({ at, id }));
}

const cloudExecutor = sql`jsonb_build_object(
  'kind', 'cloud', 'deviceId', NULL, 'name', 'AI Gateway',
  'platform', 'cloud', 'appVersion', NULL, 'osVersion', NULL
)`;

/**
 * Domain rows remain authoritative. This is only the cross-domain activity
 * projection; it neither schedules work nor infers device activity.
 */
function runProjection(partyId: string | null): SQL {
  return sql`
    SELECT
      j.id AS internal_id,
      j."publicId" AS id,
      j.kind,
      i.shortcode AS "subjectId",
      i.filename AS "subjectName",
      '/images/' || i.shortcode AS "subjectHref",
      j.state,
      j.state IN ('pending', 'leased', 'waiting_for_device') AS active,
      j."createdAt",
      j."completedAt",
      CASE WHEN j."completedAt" IS NOT NULL AND j."dispatchedAt" IS NOT NULL
        THEN greatest(0, extract(epoch FROM (j."completedAt" - j."dispatchedAt")) * 1000)
      END AS "durationMs",
      j.attempts,
      COALESCE(
        (SELECT jsonb_agg(DISTINCT executor) FROM (
          SELECT a.executor
          FROM "ImageProcessingAttempt" a
          WHERE a."jobId" = j.id AND a.executor IS NOT NULL
          UNION ALL
          SELECT ${cloudExecutor}
          WHERE j.kind = 'describe_image'
            AND j."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION}
        ) execution),
        '[]'::jsonb
      ) AS executors,
      CASE WHEN EXISTS(
        SELECT 1 FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND u."estimatedCost" IS NULL AND (
          (u."jobKind" = 'image_processing_attempt' AND u."jobId" IN (
            SELECT a.id::text FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id
          ))
          OR (u."jobKind" = 'describe_image' AND u."jobId" = j.id::text)
        )
      ) THEN NULL ELSE (
        SELECT sum(u."estimatedCost") FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND (
          (u."jobKind" = 'image_processing_attempt' AND u."jobId" IN (
            SELECT a.id::text FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id
          ))
          OR (u."jobKind" = 'describe_image' AND u."jobId" = j.id::text)
        )
      ) END AS "estimatedCost",
      j."lastError" AS error,
      EXISTS(SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id) AS "hasDiagnostics",
      j.state = 'failed'
        AND i.sha256 = j."sourceContentHash"
        AND ((j.kind = 'describe_image' AND j."processorRevision" IN (${IMAGE_DESCRIPTION_PROCESSOR_REVISION}, ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}))
          OR (j.kind = 'subject_lift' AND j."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION})) AS "canRetry"
    FROM "ImageProcessingJob" j
    JOIN "Image" i ON i.id = j."imageId" AND i."deletedAt" IS NULL

    UNION ALL

    SELECT
      r.id AS internal_id,
      r.shortcode AS id,
      CASE r.purpose
        WHEN 'purchase_validation' THEN 'purchase_validation'
        WHEN 'product_enrichment' THEN 'product_enrichment'
        WHEN 'photo_inventory' THEN 'photo_inventory'
        ELSE 'purchase_import'
      END AS kind,
      v.shortcode AS "subjectId",
      -- A photo-inventory run has no vendor: name the run itself rather than
      -- falling into the vendor-agent label every other purpose shares.
      CASE
        WHEN r.purpose = 'photo_inventory' THEN 'Photo inventory'
        ELSE coalesce(v.name, 'Purchase agent')
      END AS "subjectName",
      CASE
        WHEN v.shortcode IS NOT NULL THEN '/vendors/' || v.shortcode
        WHEN r.purpose = 'photo_inventory' THEN '/runs/' || r.shortcode
      END AS "subjectHref",
      r.status AS state,
      r.status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval') AS active,
      r."startedAt" AS "createdAt",
      r."endedAt" AS "completedAt",
      CASE WHEN r."endedAt" IS NOT NULL
        THEN greatest(0, extract(epoch FROM (r."endedAt" - r."startedAt")) * 1000)
      END AS "durationMs",
      r."dispatchAttempts" AS attempts,
      (SELECT jsonb_agg(DISTINCT executor) FROM (
        SELECT o.executor
        FROM "RunOperation" o
        WHERE o."runId" = r.id AND o.executor IS NOT NULL
        UNION ALL SELECT ${cloudExecutor}
      ) execution) AS executors,
      CASE WHEN EXISTS(
        SELECT 1 FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND u."runId" = r.id AND u."estimatedCost" IS NULL
      ) THEN NULL ELSE (
        SELECT sum(u."estimatedCost") FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND u."runId" = r.id
      ) END AS "estimatedCost",
      coalesce(r."dispatchError", r."failureCode") AS error,
      EXISTS(SELECT 1 FROM "RunOperation" o WHERE o."runId" = r.id) AS "hasDiagnostics",
      false AS "canRetry"
    FROM "Run" r
    LEFT JOIN "Vendor" v ON v.id = r."vendorId" AND v."deletedAt" IS NULL
    WHERE ${partyId}::uuid IS NOT NULL AND r."ledgerPartyId" = ${partyId}::uuid
  `;
}

const runWire = activityRun.extend({
  createdAt: z.coerce.date().transform((date) => date.toISOString()),
  completedAt: z.coerce
    .date()
    .nullable()
    .transform((date) => date?.toISOString() ?? null),
  durationMs: z.coerce.number().nullable(),
  estimatedCost: z.coerce.number().nullable(),
});

function listPredicate(input: ActivityListInput): SQL {
  const clauses: SQL[] = [sql`true`];
  if (input.kind) clauses.push(sql`kind = ${input.kind}`);
  if (input.state) clauses.push(sql`state = ${input.state}`);
  if (input.from)
    clauses.push(
      sql`"createdAt" >= (${input.from}::timestamptz AT TIME ZONE 'UTC')`,
    );
  if (input.to)
    clauses.push(
      sql`"createdAt" <= (${input.to}::timestamptz AT TIME ZONE 'UTC')`,
    );
  if (input.subjectId) {
    clauses.push(sql`(
      "subjectId" = ${input.subjectId}
      OR internal_id IN (
        SELECT t."runId"
        FROM "RunTarget" t
        LEFT JOIN "Product" product ON product.id = t."productId" AND product."deletedAt" IS NULL
        LEFT JOIN "Purchase" purchase ON purchase.id = t."purchaseId" AND purchase."deletedAt" IS NULL
        WHERE product.shortcode = ${input.subjectId} OR purchase.shortcode = ${input.subjectId}
      )
    )`);
  }
  if (input.submissionId) {
    clauses.push(sql`internal_id IN (
      SELECT membership."jobId"
      FROM "ImageProcessingSubmissionJob" membership
      JOIN "ImageProcessingSubmission" s ON s.id = membership."submissionId"
      WHERE s."publicId" = ${input.submissionId}
    )`);
  }
  if (input.executor === "unknown") {
    clauses.push(sql`(
      jsonb_array_length(executors) = 0
      OR (kind IN ('purchase_import', 'purchase_validation', 'product_enrichment')
        AND EXISTS(
          SELECT 1 FROM "RunOperation" operation
          WHERE operation."runId" = internal_id AND operation.executor IS NULL
        ))
    )`);
  }
  if (input.executor === "cloud") {
    clauses.push(sql`EXISTS(
      SELECT 1 FROM jsonb_array_elements(executors) executor
      WHERE executor->>'kind' = 'cloud'
    )`);
  }
  if (input.executor === "device") {
    clauses.push(sql`EXISTS(
      SELECT 1 FROM jsonb_array_elements(executors) executor
      WHERE executor->>'kind' = 'device'
    )`);
  }
  if (input.deviceId) {
    clauses.push(sql`EXISTS(
      SELECT 1 FROM jsonb_array_elements(executors) executor
      WHERE executor->>'kind' = 'device'
        AND executor->>'deviceId' = ${input.deviceId}
    )`);
  }
  return sql.join(clauses, sql` AND `);
}

export async function listActivity(
  db: Database,
  partyId: string | null,
  input: ActivityListInput,
) {
  const cursor = decodeCursor(input.cursor);
  const ascending = input.sort === "oldest";
  const direction = ascending ? sql`ASC` : sql`DESC`;
  const after = cursor
    ? ascending
      ? sql`("createdAt", id) > ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id})`
      : sql`("createdAt", id) < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id})`
    : sql`true`;
  const query = await getDb(db).execute(sql`
    WITH runs AS (${runProjection(partyId)}),
    filtered AS (SELECT * FROM runs WHERE ${listPredicate(input)}),
    page AS (
      SELECT *, to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM filtered
      WHERE ${after}
      ORDER BY "createdAt" ${direction}, id ${direction}
      LIMIT ${input.limit + 1}
    )
    SELECT
      (SELECT count(*)::int FROM filtered) AS total,
      coalesce(
        (SELECT jsonb_agg(
          to_jsonb(page) || jsonb_build_object(
            'createdAt', to_char(page."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'completedAt', CASE WHEN page."completedAt" IS NULL THEN NULL
              ELSE to_char(page."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
          ) ORDER BY "createdAt" ${direction}, id ${direction}
        ) FROM page),
        '[]'::jsonb
      ) AS items
  `);
  const data = z
    .object({
      total: z.coerce.number(),
      items: z.array(runWire.extend({ cursorAt: z.iso.datetime() })),
    })
    .parse(query.rows[0]);
  const pageItems = data.items.slice(0, input.limit);
  const last = pageItems.at(-1);
  return activityListOutput.parse({
    items: pageItems,
    total: data.total,
    nextCursor:
      data.items.length > input.limit && last
        ? encodeCursor(last.cursorAt, last.id)
        : null,
  });
}

async function resolveActivity(
  db: Database,
  partyId: string | null,
  id: string,
) {
  const query = await getDb(db).execute(sql`
    WITH runs AS (${runProjection(partyId)})
    SELECT * FROM runs WHERE id = ${id} LIMIT 1
  `);
  const found = z
    .object({ internal_id: z.string() })
    .passthrough()
    .safeParse(query.rows[0]);
  if (!found.success) throw new Error("Activity run was not found");
  return { internalId: found.data.internal_id, run: runWire.parse(found.data) };
}

const activityAttemptWire = activityAttempt.extend({
  startedAt: z.coerce.date().transform((date) => date.toISOString()),
  completedAt: z.coerce
    .date()
    .nullable()
    .transform((date) => date?.toISOString() ?? null),
});

async function loadImageAttempts(
  db: Database,
  jobId: string,
  cursor: string | undefined,
  limit: number,
) {
  const beforeNumber = cursor
    ? z.coerce.number().int().positive().parse(cursor)
    : null;
  const rows = await getDb(db)
    .select({
      number: imageProcessingAttempt.number,
      state: imageProcessingAttempt.state,
      startedAt: imageProcessingAttempt.startedAt,
      completedAt: imageProcessingAttempt.completedAt,
      executor: imageProcessingAttempt.executor,
      diagnosticsJson: sql<string | null>`jsonb_build_object(
        'attempt', ${imageProcessingAttempt.diagnostics},
        'usage', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'inputTokens', ${aiUsage.inputTokens},
            'outputTokens', ${aiUsage.outputTokens},
            'status', ${aiUsage.status},
            'durationMs', ${aiUsage.durationMs},
            'estimatedCost', ${aiUsage.estimatedCost},
            'gatewayLogId', ${aiUsage.gatewayLogId}
          ) ORDER BY ${aiUsage.createdAt})
          FROM ${aiUsage}
          WHERE ${aiUsage.jobKind} = 'image_processing_attempt'
            AND ${aiUsage.jobId} = ${imageProcessingAttempt.id}::text
            AND ${aiUsage.deletedAt} IS NULL
        ), '[]'::jsonb)
      )::text`,
      resultJson: sql<string | null>`${imageProcessingAttempt.result}::text`,
      error: imageProcessingAttempt.error,
    })
    .from(imageProcessingAttempt)
    .where(
      and(
        eq(imageProcessingAttempt.jobId, jobId),
        beforeNumber
          ? sql`${imageProcessingAttempt.number} < ${beforeNumber}`
          : undefined,
      ),
    )
    .orderBy(desc(imageProcessingAttempt.number))
    .limit(limit + 1);
  return rows.map((row) => activityAttemptWire.parse(row));
}

export async function activityDetail(
  db: Database,
  partyId: string | null,
  input: { id: string; cursor?: string; limit: number },
) {
  const { run, internalId } = await resolveActivity(db, partyId, input.id);
  // Purchase runs expose their domain operations through activityEvents. They
  // are not execution attempts: historical browser operations lack a stable
  // attempt identity and executor attribution.
  if (input.id.startsWith("RUN-")) {
    return activityDetailOutput.parse({
      run,
      attempts: [],
      nextAttemptCursor: null,
    });
  }
  const attempts = await loadImageAttempts(
    db,
    internalId,
    input.cursor,
    input.limit,
  );
  const last = attempts.slice(0, input.limit).at(-1);
  return activityDetailOutput.parse({
    run,
    attempts: attempts.slice(0, input.limit),
    nextAttemptCursor:
      attempts.length > input.limit && last ? String(last.number) : null,
  });
}

export async function activityEvents(
  db: Database,
  partyId: string | null,
  input: { id: string; cursor?: string; limit: number },
) {
  const { internalId } = await resolveActivity(db, partyId, input.id);
  const cursor = decodeCursor(input.cursor);
  const events = input.id.startsWith("IPR-")
    ? sql`
        SELECT id::text, "occurredAt", source, event, level, attempt,
          details::text AS "detailsJson"
        FROM "ImageProcessingEvent" WHERE "jobId" = ${internalId}::uuid
      `
    : sql`
        SELECT
          id::text,
          "startedAt" AS "occurredAt",
          CASE
            WHEN kind = '__debug_event' THEN 'device'
            WHEN executor->>'kind' = 'device' THEN 'device'
            WHEN executor->>'kind' = 'cloud' THEN 'cloud'
            ELSE 'server'
          END AS source,
          CASE WHEN kind = '__debug_event' THEN coalesce(result->>'event', 'device.event') ELSE 'operation.' || kind END AS event,
          CASE WHEN state = 'failed' THEN 'error' ELSE 'info' END AS level,
          NULL::int AS attempt,
          CASE WHEN kind = '__debug_event' THEN result::text
            ELSE jsonb_build_object(
              -- Runs are already owner-scoped by resolveActivity; the first
              -- 300 characters are the diagnosis, the transcript has the rest.
              'state', state, 'error', left(error, 300),
              'operationId', "operationId", 'executor', executor
            )::text
          END AS "detailsJson"
        FROM "RunOperation" WHERE "runId" = ${internalId}::uuid
      `;
  const after = cursor
    ? sql`("occurredAt", id) < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id})`
    : sql`true`;
  const query = await getDb(db).execute(sql`
    WITH events AS (${events}), page AS (
      SELECT *, to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM events WHERE ${after}
      ORDER BY "occurredAt" DESC, id DESC
      LIMIT ${input.limit + 1}
    ) SELECT id, to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
      source, event, level, attempt, "detailsJson", "cursorAt" FROM page
  `);
  const rows = z
    .array(
      activityEvent
        .extend({
          occurredAt: z.coerce.date().transform((date) => date.toISOString()),
        })
        .extend({ cursorAt: z.iso.datetime() }),
    )
    .parse(query.rows);
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return activityEventsOutput.parse({
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.cursorAt, last.id)
        : null,
  });
}

export async function activityDevices(db: Database, partyId: string | null) {
  const query = await getDb(db).execute(sql`
    WITH runs AS (${runProjection(partyId)}), observations AS (
      SELECT a.executor, a."startedAt" AS observed_at, a.id::text AS id
      FROM "ImageProcessingAttempt" a JOIN runs r ON r.internal_id = a."jobId" AND r.id LIKE 'IPR-%'
      UNION ALL
      SELECT o.executor, o."startedAt" AS observed_at, o.id::text AS id
      FROM "RunOperation" o JOIN runs r ON r.internal_id = o."runId" AND r.id LIKE 'RUN-%'
    )
    SELECT DISTINCT ON (executor->>'deviceId') executor FROM observations
    WHERE executor->>'kind' = 'device' AND executor->>'deviceId' IS NOT NULL
    ORDER BY executor->>'deviceId', observed_at DESC, id DESC
  `);
  return activityDevicesOutput.parse({
    items: query.rows.map((row) => row.executor),
  });
}

export async function activitySubmission(db: Database, id: string) {
  const query = await getDb(db).execute(sql`
    SELECT
      s."publicId" AS id,
      s."createdAt",
      count(m.id)::int AS total,
      count(m.id) FILTER (WHERE m.disposition IN ('new', 'retry'))::int AS "newlyQueued",
      count(m.id) FILTER (WHERE m.disposition = 'reused')::int AS reused,
      count(m.id) FILTER (WHERE m.disposition = 'running')::int AS "alreadyRunning",
      count(m.id) FILTER (WHERE j.state = 'ready')::int AS completed,
      count(m.id) FILTER (WHERE j.state = 'skipped')::int AS skipped,
      count(m.id) FILTER (WHERE j.state = 'failed')::int AS failed,
      count(m.id) FILTER (WHERE j.state IN ('pending', 'leased', 'waiting_for_device'))::int AS remaining,
      CASE WHEN EXISTS(
        SELECT 1 FROM "ImageProcessingAttempt" a
        JOIN "AiUsage" u ON u."jobKind" = 'image_processing_attempt'
          AND u."jobId" = a.id::text AND u."deletedAt" IS NULL
        WHERE a."submissionId" = s.id AND u."estimatedCost" IS NULL
      ) THEN NULL ELSE (
        SELECT sum(u."estimatedCost") FROM "ImageProcessingAttempt" a
        JOIN "AiUsage" u ON u."jobKind" = 'image_processing_attempt'
          AND u."jobId" = a.id::text AND u."deletedAt" IS NULL
        WHERE a."submissionId" = s.id
      ) END AS "estimatedCost"
    FROM "ImageProcessingSubmission" s
    LEFT JOIN "ImageProcessingSubmissionJob" m ON m."submissionId" = s.id
    LEFT JOIN "ImageProcessingJob" j ON j.id = m."jobId"
    WHERE s."publicId" = ${id}
    GROUP BY s.id
  `);
  return activitySubmissionOutput
    .extend({
      createdAt: z.coerce.date().transform((date) => date.toISOString()),
      estimatedCost: z.coerce.number().nullable(),
    })
    .parse(query.rows[0]);
}

export async function imageAnalysisHistory(
  db: Database,
  input: { id: string; cursor?: string; limit: number },
) {
  const imageId = await resolveOrThrow(db, "image", input.id);
  const predicate = and(
    eq(aiAnalysis.entityType, "image"),
    eq(aiAnalysis.entityId, imageId),
    eq(aiAnalysis.feature, "image-description"),
    isNull(aiAnalysis.deletedAt),
  );
  const cursor = decodeCursor(input.cursor);
  const [rows, totals, current] = await Promise.all([
    getDb(db)
      .select()
      .from(aiAnalysis)
      .where(
        and(
          predicate,
          cursor
            ? sql`(date_trunc('milliseconds', ${aiAnalysis.createdAt}), ${aiAnalysis.id}) < (date_trunc('milliseconds', ${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(
        desc(sql`date_trunc('milliseconds', ${aiAnalysis.createdAt})`),
        desc(aiAnalysis.id),
      )
      .limit(input.limit + 1),
    getDb(db)
      .select({ total: sql<number>`count(*)::int` })
      .from(aiAnalysis)
      .where(predicate),
    getImageProcessingReadProjection(db, imageId),
  ]);
  const preferred = current.analyses.find((analysis) => analysis.preferred);
  const page = rows.slice(0, input.limit);
  const items: z.output<typeof imageDescriptionAnalysis>[] = [];
  const unparsed: Array<{
    provider: string | null;
    model: string | null;
    promptVersion: string;
    resultSchemaRevision: number | null;
    createdAt: string;
    rawResultJson: string;
    reason: string;
  }> = [];
  for (const row of page) {
    const result = imageDescriptionResult.safeParse(row.result);
    if (!result.success) {
      unparsed.push({
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        resultSchemaRevision: row.resultSchemaRevision,
        createdAt: row.createdAt.toISOString(),
        rawResultJson: JSON.stringify(row.result),
        reason: result.error.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }
    const entry = imageDescriptionAnalysis.safeParse({
      provider: row.provider ?? "legacy",
      model: row.model,
      promptRevision: Number(row.promptVersion),
      resultSchemaRevision: row.resultSchemaRevision ?? 1,
      inputFingerprint: row.inputFingerprint,
      result: result.data,
      runtime: row.runtime,
      createdAt: row.createdAt.toISOString(),
      preferred:
        row.inputFingerprint === preferred?.inputFingerprint &&
        row.createdAt.toISOString() === preferred?.createdAt,
    });
    if (entry.success) {
      items.push(entry.data);
    } else {
      unparsed.push({
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        resultSchemaRevision: row.resultSchemaRevision,
        createdAt: row.createdAt.toISOString(),
        rawResultJson: JSON.stringify(row.result),
        reason: entry.error.issues.map((issue) => issue.message).join("; "),
      });
    }
  }
  const last = page.at(-1);
  return imageAnalysisHistoryOutput.parse({
    items,
    unparsed,
    total: totals[0]?.total ?? 0,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.createdAt.toISOString(), last.id)
        : null,
  });
}
