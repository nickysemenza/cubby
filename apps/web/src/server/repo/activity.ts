import {
  ACTIVITY_KIND_LABEL,
  activityAttempt,
  targetOutcomeSummary,
  activityDetailOutput,
  activityDevicesOutput,
  activityEvent,
  activityEventsOutput,
  activityGroupsOutput,
  activityListOutput,
  activityRun,
  activityIconEntity,
  activitySubmissionOutput,
  imageAnalysisHistoryOutput,
  type ActivityListInput,
} from "@cubby/schemas/activity";
import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId, parseEntityRef } from "@cubby/schemas/identifiers";
import {
  imageDescriptionAnalysis,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import { RUN_TARGET_BUCKET } from "@cubby/schemas/purchase-import";
import { runTargetEntityKind, runWorkLabel } from "@cubby/schemas/run-fields";
import { parseShortcode } from "@cubby/shared";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { imageProcessingAttempt } from "~/server/db/image-processing-schema";
import { aiAnalysis, aiUsage } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  resolveEntityDisplayImages,
  resolvePublicEntityDisplayImages,
} from "~/server/repo/entity-display-image";
import {
  lookupEntityLabels,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

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
function runProjection(): SQL {
  return sql`
    SELECT
      j.id AS internal_id,
      j."publicId" AS id,
      'image_job' AS "recordType",
      parent.shortcode AS "parentRunId",
      j.kind,
      parent.trigger,
      parent_account.shortcode AS "vendorAccountId",
      parent_vendor.shortcode AS "vendorId",
      parent_party.shortcode AS "ledgerPartyId",
      i.shortcode AS "subjectId",
      i.filename AS "subjectName",
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
      false AS routine,
      EXISTS(SELECT 1 FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id) AS "hasDiagnostics",
      coalesce(j.state = 'failed'
        AND i.sha256 = j."sourceContentHash"
        AND ((j.kind = 'describe_image' AND j."processorRevision" IN (${IMAGE_DESCRIPTION_PROCESSOR_REVISION}, ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}))
          OR (j.kind = 'subject_lift' AND j."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION})), false) AS "canRetry"
    FROM "ImageProcessingJob" j
    JOIN "Image" i ON i.id = j."imageId" AND i."deletedAt" IS NULL
    LEFT JOIN "Run" parent ON parent.id = j."runId" AND parent."deletedAt" IS NULL
    LEFT JOIN "VendorAccount" parent_account ON parent_account.id = parent."vendorAccountId" AND parent_account."deletedAt" IS NULL
    LEFT JOIN "Vendor" parent_vendor ON parent_vendor.id = parent."vendorId" AND parent_vendor."deletedAt" IS NULL
    LEFT JOIN "LedgerParty" parent_party ON parent_party.id = parent."ledgerPartyId" AND parent_party."deletedAt" IS NULL

    UNION ALL

    SELECT
      r.id AS internal_id,
      r.shortcode AS id,
      'run' AS "recordType",
      causal_parent.shortcode AS "parentRunId",
      r.purpose AS kind,
      r.trigger,
      account.shortcode AS "vendorAccountId",
      v.shortcode AS "vendorId",
      party.shortcode AS "ledgerPartyId",
      v.shortcode AS "subjectId",
      -- A photo-inventory run has no vendor: name the run itself rather than
      -- falling into the vendor-agent label every other purpose shares.
      CASE
        WHEN r.purpose = 'photo_inventory' THEN 'Photo inventory'
        WHEN v.name IS NOT NULL THEN v.name
        ELSE initcap(replace(r.purpose, '_', ' '))
      END AS "subjectName",
      r.status AS state,
      r.status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval') AS active,
      r."startedAt" AS "createdAt",
      r."endedAt" AS "completedAt",
      CASE WHEN r."endedAt" IS NOT NULL
        THEN greatest(0, extract(epoch FROM (r."endedAt" - r."startedAt")) * 1000)
      END AS "durationMs",
      (SELECT count(*)::int FROM "RunOperation" o WHERE o."runId" = r.id) AS attempts,
      COALESCE((SELECT jsonb_agg(DISTINCT executor) FROM (
        SELECT o.executor
        FROM "RunOperation" o
        WHERE o."runId" = r.id AND o.executor IS NOT NULL
        UNION ALL SELECT ${cloudExecutor}
        WHERE r.purpose IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory')
          OR EXISTS(SELECT 1 FROM "AiUsage" u WHERE u."runId" = r.id AND u."deletedAt" IS NULL)
      ) execution), '[]'::jsonb) AS executors,
      CASE WHEN EXISTS(
        SELECT 1 FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND u."runId" = r.id AND u."estimatedCost" IS NULL
      ) THEN NULL ELSE (
        SELECT sum(u."estimatedCost") FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND u."runId" = r.id
      ) END AS "estimatedCost",
      coalesce(r."dispatchError", r."failureCode") AS error,
      r.routine,
      EXISTS(SELECT 1 FROM "RunOperation" o WHERE o."runId" = r.id) AS "hasDiagnostics",
      false AS "canRetry"
    FROM "Run" r
    -- includes-deleted: historical subject identity survives tombstoning, as in ordinary Run reads.
    LEFT JOIN "Vendor" v ON v.id = r."vendorId"
    LEFT JOIN "VendorAccount" account ON account.id = r."vendorAccountId" AND account."deletedAt" IS NULL
    LEFT JOIN "LedgerParty" party ON party.id = r."ledgerPartyId"
    LEFT JOIN "Run" causal_parent ON causal_parent.id = r."parentRunId" AND causal_parent."deletedAt" IS NULL
    WHERE r."deletedAt" IS NULL
  `;
}

/** Only retained live parent edges group work; legacy null edges remain roots. */
function groupedRunProjection(): SQL {
  return sql`
    WITH RECURSIVE projected AS (${runProjection()}),
    lineage AS (
      SELECT id, id AS "groupRootId" FROM projected WHERE "parentRunId" IS NULL
      UNION ALL
      SELECT child.id, lineage."groupRootId"
      FROM projected child JOIN lineage ON child."parentRunId" = lineage.id
    )
    SELECT projected.*, coalesce(lineage."groupRootId", projected.id) AS "groupRootId"
    FROM projected LEFT JOIN lineage ON lineage.id = projected.id
  `;
}

const runWire = activityRun
  .omit({
    iconEntity: true,
    dataQuality: true,
    subjectImage: true,
    workLabel: true,
    currentStep: true,
    targetCounts: true,
    targetSummary: true,
    targetPreview: true,
    changedCount: true,
  })
  .extend({
    internal_id: z.string(),
    createdAt: z.coerce.date().transform((date) => date.toISOString()),
    completedAt: z.coerce
      .date()
      .nullable()
      .transform((date) => date?.toISOString() ?? null),
    durationMs: z.coerce.number().nullable(),
    estimatedCost: z.coerce.number().nullable(),
  });
type RunWire = z.infer<typeof runWire>;

/** One count per `RUN_TARGET_BUCKET`, so SQL and every client agree. */
const targetBucketCounts = sql.join(
  (["completed", "skipped", "blocked", "pending"] as const).map(
    (bucket) =>
      sql`${bucket}::text, count(*) FILTER (WHERE t.state IN (${sql.join(
        Object.entries(RUN_TARGET_BUCKET)
          .filter(([, value]) => value === bucket)
          .map(([state]) => sql`${state}`),
        sql`, `,
      )}))`,
  ),
  sql`, `,
);

/** How many targets a row names; the counts cover the rest. */
const TARGET_PREVIEW_LIMIT = 3;

const runFactsRow = z.object({
  internalId: z.string(),
  input: z.unknown(),
  currentStep: z.string().nullable(),
  targetCounts: activityRun.shape.targetCounts.unwrap(),
  targets: z.array(
    z.object({
      entityKind: runTargetEntityKind,
      entityId: z.string(),
      shortcode: z.string(),
      state: z.string(),
    }),
  ),
  changedCount: z.coerce.number(),
});

/**
 * Facts for a page of rows only: the projection stays cheap to filter and
 * count, and the per-run subqueries below run once per shown row.
 */
async function loadRunFacts(db: Database, internalIds: readonly string[]) {
  if (internalIds.length === 0)
    return new Map<string, z.infer<typeof runFactsRow>>();
  const query = await getDb(db).execute(sql`
    SELECT
      r.id AS "internalId",
      r.input,
      (SELECT coalesce(p.detail, p.phase) FROM "RunProgress" p
        WHERE p."runId" = r.id
        ORDER BY p."createdAt" DESC, p.id DESC LIMIT 1) AS "currentStep",
      (SELECT jsonb_build_object('total', count(*), ${targetBucketCounts})
        FROM "RunTarget" t WHERE t."runId" = r.id) AS "targetCounts",
      coalesce((SELECT jsonb_agg(jsonb_build_object(
          'entityKind', shown."entityKind", 'entityId', shown."entityId",
          'shortcode', shown.shortcode, 'state', shown.state
        ) ORDER BY shown.position NULLS LAST, shown."createdAt", shown.id)
        FROM (
          SELECT t.id, t.position, t."createdAt", t."entityKind", t."entityId", t.state, identity.shortcode
          FROM "RunTarget" t
          JOIN "Entity" identity ON identity.id = t."entityId"
          WHERE t."runId" = r.id
          -- The order the run works its targets in (targetWorkOrder).
          ORDER BY t.position NULLS LAST, t."createdAt", t.id
          LIMIT ${TARGET_PREVIEW_LIMIT}
        ) shown), '[]'::jsonb) AS targets,
      (SELECT count(DISTINCT (a."entityKind", a."entityId"))
        FROM "AuditLog" a WHERE a."runId" = r.id) AS "changedCount"
    FROM "Run" r
    WHERE r.id IN (${sql.join(
      internalIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  return new Map(
    query.rows.map((row) => {
      const facts = runFactsRow.parse(row);
      return [facts.internalId, facts] as const;
    }),
  );
}

/** Rows as the Runs list shows them: what the work is and what it touched. */
async function presentActivityRuns(db: Database, rows: readonly RunWire[]) {
  const facts = await loadRunFacts(
    db,
    rows
      .filter((row) => row.recordType === "run")
      .map((row) => row.internal_id),
  );
  const targets = [...facts.values()].flatMap((fact) => fact.targets);
  const targetRefs = targets.map((target) => ({
    entityKind: target.entityKind,
    entityId: target.entityId,
  }));
  const [names, targetImages, subjectImages, qualities] = await Promise.all([
    lookupEntityLabels(
      db,
      targetRefs.map((ref) => parseEntityRef(ref.entityKind, ref.entityId)),
    ),
    resolveEntityDisplayImages(db, targetRefs),
    resolvePublicEntityDisplayImages(
      db,
      rows.flatMap((row) => {
        const parsed = row.subjectId ? parseShortcode(row.subjectId) : null;
        return parsed
          ? [{ entityKind: parsed.type, entityId: row.subjectId! }]
          : [];
      }),
    ),
    loadDataQualities(
      db,
      "run",
      rows
        .filter((row) => row.recordType === "run")
        .map((row) => parseEntityId("run", row.internal_id)),
    ),
  ]);
  return rows.map(({ internal_id: internalId, ...row }) => {
    const fact = facts.get(internalId);
    const subject = row.subjectId ? parseShortcode(row.subjectId) : null;
    return activityRun.parse({
      ...row,
      dataQuality:
        row.recordType === "run"
          ? qualities.get(parseEntityId("run", internalId))
          : null,
      iconEntity: activityIconEntity({
        kind: row.kind,
        subjectId: row.subjectId,
        ledgerPartyId: row.ledgerPartyId,
      }),
      subjectImage: subject
        ? (subjectImages.get(entityRefKey(subject.type, row.subjectId!)) ??
          null)
        : null,
      workLabel:
        row.recordType === "run"
          ? runWorkLabel({
              purpose: row.kind,
              input: fact?.input,
              vendorId: row.vendorId,
            })
          : ACTIVITY_KIND_LABEL[row.kind],
      currentStep: fact?.currentStep ?? null,
      targetCounts: fact?.targetCounts ?? null,
      targetSummary: targetOutcomeSummary(fact?.targetCounts ?? null),
      targetPreview: (fact?.targets ?? []).map((target) => {
        const key = entityRefKey(target.entityKind, target.entityId);
        return {
          entity: target.entityKind,
          id: target.shortcode,
          name: names.get(key) ?? null,
          state: target.state,
          displayImage: targetImages.get(key) ?? null,
        };
      }),
      changedCount: fact?.changedCount ?? 0,
    });
  });
}

function listPredicate(input: ActivityListInput): SQL {
  const clauses: SQL[] = [sql`true`];
  if (input.recordType) clauses.push(sql`"recordType" = ${input.recordType}`);
  if (input.parentRunId)
    clauses.push(sql`"parentRunId" = ${input.parentRunId}`);
  if (input.kind) clauses.push(sql`kind = ${input.kind}`);
  if (input.trigger) clauses.push(sql`trigger = ${input.trigger}`);
  if (input.excludeTriggers?.length)
    clauses.push(
      sql`(trigger IS NULL OR trigger NOT IN (${sql.join(
        input.excludeTriggers.map((value) => sql`${value}`),
        sql`, `,
      )}))`,
    );
  if (input.routine !== undefined)
    clauses.push(sql`routine = ${input.routine}`);
  if (input.vendorAccountId)
    clauses.push(sql`"vendorAccountId" = ${input.vendorAccountId}`);
  if (input.vendorId) clauses.push(sql`"vendorId" = ${input.vendorId}`);
  if (input.ledgerPartyId)
    clauses.push(sql`"ledgerPartyId" = ${input.ledgerPartyId}`);
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
        LEFT JOIN "Product" product ON product.id = t."entityId" AND product."deletedAt" IS NULL
        LEFT JOIN "Purchase" purchase ON purchase.id = t."entityId" AND purchase."deletedAt" IS NULL
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
      OR ("recordType" = 'run'
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
  _partyId: string | null,
  input: ActivityListInput,
  groupRootId?: string,
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
    WITH runs AS (${groupRootId ? groupedRunProjection() : runProjection()}),
    filtered AS (SELECT * FROM runs WHERE ${listPredicate(input)}
      ${groupRootId ? sql`AND "groupRootId" = ${groupRootId} AND id <> ${groupRootId}` : sql``}),
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
    items: await presentActivityRuns(db, pageItems),
    total: data.total,
    nextCursor:
      data.items.length > input.limit && last
        ? encodeCursor(last.cursorAt, last.id)
        : null,
  });
}

/** Page root groups, then fetch matched children only when a root expands. */
export async function listActivityGroups(
  db: Database,
  _partyId: string | null,
  input: ActivityListInput,
) {
  const cursor = decodeCursor(input.cursor);
  const ascending = input.sort === "oldest";
  const direction = ascending ? sql`ASC` : sql`DESC`;
  const after = cursor
    ? ascending
      ? sql`(aggregate."latestAt", aggregate."rootId") > ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id})`
      : sql`(aggregate."latestAt", aggregate."rootId") < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id})`
    : sql`true`;
  const query = await getDb(db).execute(sql`
    WITH runs AS (${groupedRunProjection()}),
    filtered AS (SELECT * FROM runs WHERE ${listPredicate(input)}),
    aggregate AS (
      SELECT
        "groupRootId" AS "rootId",
        max("createdAt") AS "latestAt",
        count(*) FILTER (WHERE id <> "groupRootId")::int AS "childCount",
        bool_or(id = "groupRootId") AS "rootMatched"
      FROM filtered
      GROUP BY 1
    ),
    page AS (
      SELECT
        jsonb_build_object(
          'root', to_jsonb(root) || jsonb_build_object(
            'createdAt', to_char(root."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'completedAt', CASE WHEN root."completedAt" IS NULL THEN NULL
              ELSE to_char(root."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
          ),
          'childCount', aggregate."childCount",
          'contextOnly', NOT aggregate."rootMatched",
          'latestAt', to_char(aggregate."latestAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) AS item,
        to_char(aggregate."latestAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",
        aggregate."rootId"
      FROM aggregate
      JOIN runs root ON root.id = aggregate."rootId"
      WHERE ${after}
      ORDER BY aggregate."latestAt" ${direction}, aggregate."rootId" ${direction}
      LIMIT ${input.limit + 1}
    )
    SELECT
      (SELECT count(*)::int FROM aggregate) AS total,
      (SELECT count(*)::int FROM filtered) AS "totalItems",
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY page."cursorAt" ${direction}, page."rootId" ${direction}) FROM page), '[]'::jsonb) AS items
  `);
  const data = z
    .object({
      total: z.coerce.number(),
      totalItems: z.coerce.number(),
      items: z.array(
        z.object({
          item: activityGroupsOutput.shape.items.element.extend({
            root: runWire,
          }),
          cursorAt: z.iso.datetime(),
          rootId: z.string(),
        }),
      ),
    })
    .parse(query.rows[0]);
  const pageItems = data.items.slice(0, input.limit);
  const last = pageItems.at(-1);
  const roots = await presentActivityRuns(
    db,
    pageItems.map((row) => row.item.root),
  );
  return activityGroupsOutput.parse({
    items: pageItems.map((row, index) => ({ ...row.item, root: roots[index] })),
    total: data.total,
    totalItems: data.totalItems,
    nextCursor:
      data.items.length > input.limit && last
        ? encodeCursor(last.cursorAt, last.rootId)
        : null,
  });
}

export async function listActivityGroupChildren(
  db: Database,
  partyId: string | null,
  input: ActivityListInput & { rootId: string },
) {
  return listActivity(db, partyId, input, input.rootId);
}

async function resolveActivity(
  db: Database,
  _partyId: string | null,
  id: string,
) {
  const query = await getDb(db).execute(sql`
    WITH runs AS (${runProjection()})
    SELECT * FROM runs WHERE id = ${id} LIMIT 1
  `);
  const found = z
    .object({ internal_id: z.string() })
    .passthrough()
    .safeParse(query.rows[0]);
  if (!found.success) throw new Error("Activity run was not found");
  const [run] = await presentActivityRuns(db, [runWire.parse(found.data)]);
  return { internalId: found.data.internal_id, run: run! };
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

export async function activityDevices(db: Database, _partyId: string | null) {
  const query = await getDb(db).execute(sql`
    WITH runs AS (${runProjection()}), observations AS (
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
    eq(aiAnalysis.entityKind, "image"),
    eq(aiAnalysis.entityId, imageId),
    eq(aiAnalysis.feature, "image-description"),
    notDeleted(aiAnalysis),
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
