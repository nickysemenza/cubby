/** Batched reads for Needs you and the work carrying a Run. */
import { passWork, type PassWork } from "@cubby/schemas/kernel/machinery";
import {
  needsYouPage,
  runWork,
  type NeedsYouPage,
  type RunWork,
} from "@cubby/schemas/kernel/work";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";

import { passOrder } from "./claim";
import { machineryErrorText } from "./error-presentation";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { ASK, STAGE } from "./vocab";

const publicEntity = alias(entityIdentity, "e");

type Q = Pick<RepositoryQueryClient, "execute">;

type NeedsYouSupplement = Pick<
  NeedsYouPage["items"][number],
  "entity" | "shortcode" | "firstGap"
>;

export type NeedsYouOptions = {
  limit?: number;
  offset?: number;
  additional?: readonly NeedsYouSupplement[];
};

export async function loadRunPasses(q: Q, runId: string): Promise<PassWork[]> {
  const result = await q.execute<{
    name: string;
    key: string;
    stage: string;
    availableAt: string | null;
    waitCause: string | null;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    doneAt: string | null;
    cancelledAt: string | null;
  }>(sql`
    SELECT name, key, ("durationHistory"->-1->>'ms')::float8 AS "durationMs", ${isoText(sql`"updatedAt"`)} AS "updatedAt",
      CASE WHEN "cancelledAt" IS NOT NULL THEN ${STAGE.ended}
        WHEN "doneAt" IS NOT NULL THEN ${STAGE.done}
        WHEN attempts >= "maxAttempts" THEN ${STAGE.stuck}
        WHEN "claimToken" IS NOT NULL AND "claimDeadline" > now() THEN ${STAGE.working}
        ELSE ${STAGE.waiting} END AS stage,
      ${isoText(sql`"availableAt"`)} AS "availableAt", "waitCause", attempts, "maxAttempts", "lastError",
      ${isoText(sql`"doneAt"`)} AS "doneAt", ${isoText(sql`"cancelledAt"`)} AS "cancelledAt"
    FROM "Pass" WHERE "runId" = ${runId}::uuid ORDER BY ${passOrder()}`);
  return result.rows.map((row) =>
    passWork.parse({
      ...row,
      lastError: machineryErrorText(row.lastError),
      costMicros: 0,
    }),
  );
}

/** One row per public record with a member-supplied gap, oldest first; no per-record reads. */
export async function readNeedsYou(
  db: Database,
  registry: KernelRegistry,
  options: NeedsYouOptions = {},
): Promise<NeedsYouPage> {
  const consumers = [...registry.machinery.values()].flatMap((capability) =>
    (capability.scopes ?? []).map((kind) => ({
      entity: capability.entity,
      kind,
    })),
  );
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const memberGap = sql`jsonb_path_query_first(s.gaps, '$[*] ? (@.actor == "you")')`;
  const memberActor = sql`s.gaps @> '[{"actor":"you"}]'::jsonb`;
  const actionTokens = (gap: SQL) => sql`ARRAY(
    SELECT DISTINCT ref.token
    FROM jsonb_array_elements(coalesce((${gap})->'actions', '[]'::jsonb)) action
    CROSS JOIN LATERAL (VALUES (action->>'subject'), (action->>${"field"})) ref(token)
    WHERE ref.token IS NOT NULL
  )`;
  const canonicalSubjects = (scopes: SQL) => sql`
    SELECT DISTINCT ON (ref."scopeKind", ref."scopeKey")
      ref."scopeKind", ref."scopeKey", e.id, e.kind AS entity, e.shortcode
    FROM (
      SELECT m."scopeKind", m."scopeKey", k."entityId" AS id, k.entity AS kind
      FROM ${scopes} m JOIN "RecordKey" k USING ("scopeKind", "scopeKey")
      WHERE k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
      UNION ALL
      SELECT m."scopeKind", m."scopeKey", parsed.id, split_part(m."scopeKey", ':', 1)
      FROM ${scopes} m
      CROSS JOIN LATERAL (
        SELECT CASE WHEN pg_input_is_valid(split_part(m."scopeKey", ':', 2), ${"uuid"})
                    THEN split_part(m."scopeKey", ':', 2)::uuid END AS id
      ) parsed
      WHERE m."scopeKind" IN ('fields', 'quality')
        AND m."scopeKey" = split_part(m."scopeKey", ':', 1) || ':' || parsed.id::text
      UNION ALL
      SELECT m."scopeKind", m."scopeKey", parsed.id, consumer.entity
      FROM ${scopes} m JOIN consumers consumer ON consumer.kind = m."scopeKind"
      CROSS JOIN LATERAL (
        SELECT CASE WHEN pg_input_is_valid(m."scopeKey", ${"uuid"}) THEN m."scopeKey"::uuid END AS id
      ) parsed
      WHERE m."scopeKey" = parsed.id::text
      UNION ALL
      SELECT m."scopeKind", m."scopeKey", parsed.id, split_part(ref.token, ':', 1)
      FROM ${scopes} m
      CROSS JOIN LATERAL unnest(m.action_tokens) ref(token)
      CROSS JOIN LATERAL (
        SELECT CASE WHEN pg_input_is_valid(split_part(ref.token, ':', 2), ${"uuid"})
                    THEN split_part(ref.token, ':', 2)::uuid END AS id
        OFFSET 0
      ) parsed
      WHERE ref.token = split_part(ref.token, ':', 1) || ':' || parsed.id::text
    ) ref
    JOIN "Entity" e ON e.id = ref.id AND e.kind = ref.kind
      AND ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL
    ORDER BY ref."scopeKind", ref."scopeKey", (e.kind = 'sourceOccurrence'), e.kind, e.shortcode`;
  const severity = sql`CASE stage WHEN ${STAGE.ended} THEN 0 WHEN ${STAGE.stuck} THEN 1
    WHEN ${STAGE.working} THEN 2 WHEN ${STAGE.needsYou} THEN 3 WHEN ${STAGE.waiting} THEN 4 ELSE 5 END`;
  const result = await repositoryQueries(db).execute<{
    items: unknown;
    count: number;
  }>(sql`
    WITH consumers AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(consumers)}::jsonb) c(entity text, kind text)
    ), member_scopes AS MATERIALIZED (
      SELECT s."scopeKind", s."scopeKey", s.stage,
        gap->>${"input"} IS NOT NULL AS actionable, gap->>'since' AS since,
        ${actionTokens(sql`gap`)} AS action_tokens
      FROM "ScopeState" s
      CROSS JOIN LATERAL (SELECT ${memberGap} AS gap OFFSET 0) detail
      WHERE s."mergedIntoKey" IS NULL AND ${memberActor}
    ), actionable AS MATERIALIZED (
      SELECT "scopeKind", "scopeKey", stage, since, action_tokens
      FROM member_scopes WHERE actionable
    ), eligible AS MATERIALIZED (
      SELECT DISTINCT ON (entity, shortcode) entity, shortcode, id, "scopeKind", "scopeKey", since, severity
      FROM (
        SELECT subject.*, m.since,
          min(${severity}) OVER (PARTITION BY subject.entity, subject.shortcode) AS severity
        FROM (${canonicalSubjects(sql`actionable`)}) subject
        JOIN actionable m USING ("scopeKind", "scopeKey")
        WHERE subject.shortcode IS NOT NULL
      ) ranked
      ORDER BY entity, shortcode, since NULLS LAST, "scopeKind", "scopeKey"
    ), combined AS (
      SELECT *, NULL::text AS "firstGap", 0::bigint AS ordinal FROM eligible
      UNION ALL
      SELECT extra.item->>'entity', extra.item->>${"shortcode"}, NULL::uuid,
        NULL::text, NULL::text, NULL::text, 3, extra.item->>'firstGap', extra.ordinal
      FROM jsonb_array_elements(${JSON.stringify(options.additional ?? [])}::jsonb)
        WITH ORDINALITY AS extra(item, ordinal)
      WHERE NOT EXISTS (
        SELECT 1 FROM eligible
        WHERE entity = extra.item->>'entity' AND shortcode = extra.item->>${"shortcode"}
      )
    ), page AS MATERIALIZED (
      SELECT * FROM combined ORDER BY ordinal, since NULLS LAST, entity, shortcode LIMIT ${limit} OFFSET ${offset}
    ), siblings AS (
      SELECT k."scopeKind", k."scopeKey", p.id
      FROM page p JOIN "RecordKey" k ON k.entity = p.entity AND k."entityId" = p.id
      WHERE k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
      UNION
      SELECT kind, p.entity || ':' || p.id::text, p.id
      FROM page p CROSS JOIN (VALUES ('fields'), ('quality')) builtins(kind)
      WHERE p.id IS NOT NULL
      UNION
      SELECT consumer.kind, p.id::text, p.id
      FROM page p JOIN consumers consumer ON consumer.entity = p.entity
      WHERE p.id IS NOT NULL
      UNION
      SELECT m."scopeKind", m."scopeKey", p.id
      FROM member_scopes m
      JOIN page p ON (p.entity || ':' || p.id::text) = ANY(m.action_tokens)
      WHERE NOT m.actionable
    ), sibling_scopes AS MATERIALIZED (
      SELECT k."scopeKind", k."scopeKey", detail.stage, detail.action_tokens
      FROM (SELECT DISTINCT "scopeKind", "scopeKey" FROM siblings) k
      CROSS JOIN LATERAL (
        SELECT s.stage, ${actionTokens(memberGap)} AS action_tokens
        FROM "ScopeState" s
        WHERE s."scopeKind" = k."scopeKind" AND s."scopeKey" = k."scopeKey"
          AND s."mergedIntoKey" IS NULL AND (${memberGap})->>${"input"} IS NULL
        LIMIT 1
      ) detail
    ), sibling_severity AS (
      SELECT subject.id, min(${severity}) AS severity
      FROM (${canonicalSubjects(sql`sibling_scopes`)}) subject
      JOIN sibling_scopes USING ("scopeKind", "scopeKey")
      JOIN siblings USING ("scopeKind", "scopeKey", id)
      GROUP BY subject.id
    )
    SELECT (SELECT count(*)::int FROM combined) AS count,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'entity', page.entity, ${"shortcode"}::text, page.shortcode, 'stage', CASE least(page.severity, sibling_severity.severity)
            WHEN 0 THEN ${STAGE.ended} WHEN 1 THEN ${STAGE.stuck} WHEN 2 THEN ${STAGE.working}
            WHEN 3 THEN ${STAGE.needsYou} WHEN 4 THEN ${STAGE.waiting} ELSE ${STAGE.done} END,
          'since', page.since,
          'firstGap', CASE WHEN page.ordinal = 0 THEN detail.gap->>${"input"} ELSE page."firstGap" END,
          'actions', CASE WHEN page.ordinal = 0 THEN detail.gap->'actions' ELSE '[]'::jsonb END
        ) ORDER BY page.ordinal, page.since NULLS LAST, page.entity, page.shortcode)
        FROM page LEFT JOIN sibling_severity USING (id)
        LEFT JOIN LATERAL (
          SELECT ${memberGap} AS gap
          FROM "ScopeState" s WHERE page.ordinal = 0
            AND s."scopeKind" = page."scopeKind" AND s."scopeKey" = page."scopeKey"
        ) detail ON true
      ), '[]'::jsonb) AS items`);
  return needsYouPage.parse(result.rows[0]);
}

/** Scopes tied through evidence or Ask waiters, asks, and Pass instances carrying one Run. */
export async function readRunWork(
  db: Database,
  registry: KernelRegistry,
  runId: string,
): Promise<RunWork> {
  return repositoryTransactionDatabase(
    db,
    async (tx) => {
      const q = repositoryQueries(tx);
      const sources = [...registry.evidence.values()].flatMap((evidence) => {
        const columns = getTableColumns(evidence.table);
        return columns.runId
          ? [
              sql`SELECT ${evidence.kind}::text AS kind, ${columns.id}::text AS id FROM ${evidence.table} WHERE ${columns.runId} = ${runId}::uuid`,
            ]
          : [];
      });
      const facts = sources.length
        ? sql.join(sources, sql` UNION ALL `)
        : sql`SELECT NULL::text AS kind, NULL::text AS id WHERE false`;
      const [scopes, asks, passes] = await Promise.all([
        q.execute<{
          kind: string;
          key: string;
          attempts: number;
          nextAt: string | null;
          durationMs: number | null;
          reconciledAt: string | null;
          lastError: string | null;
          stage: string;
          firstGap: string | null;
          costMicros: number;
        }>(sql`
        WITH facts AS (${facts}), wanted AS (
          SELECT DISTINCT d."scopeKind" AS kind, d."scopeKey" AS key
          FROM facts f JOIN "FactKey" k ON k."factKind" = f.kind AND k."factId" = f.id
          JOIN "ScopeDep" d ON d.key = k.key
          UNION SELECT "scopeKind", "scopeKey" FROM "AskScope" WHERE "runId" = ${runId}::uuid
          UNION SELECT 'fields', 'run:' || ${runId}::text
          UNION SELECT 'quality', 'run:' || ${runId}::text
        )
        SELECT w.kind, w.key,
          (SELECT jsonb_build_object('entity',e.kind,'id',e.shortcode) FROM "RecordKey" k
           JOIN "Entity" e ON e.id=k."entityId" AND e.kind=k.entity
           WHERE k."scopeKind"=w.kind AND k."scopeKey"=w.key AND k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
             AND ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL ORDER BY e.shortcode LIMIT 1) AS record,
          coalesce(d.attempts,0) AS attempts, ${isoText(sql`d."availableAt"`)} AS "nextAt",
          s."durationMs", ${isoText(sql`s."reconciledAt"`)} AS "reconciledAt", coalesce(d."lastError", s.error) AS "lastError",
          CASE WHEN d."claimToken" IS NOT NULL AND d."claimDeadline" > now() THEN ${STAGE.working}
            ELSE coalesce(s.stage, ${STAGE.waiting}) END AS stage,
          s."firstGap", coalesce(cost.total, 0)::float8 AS "costMicros"
        FROM wanted w LEFT JOIN "ScopeState" s ON s."scopeKind" = w.kind AND s."scopeKey" = w.key
        LEFT JOIN "ScopeDirty" d ON d."scopeKind" = w.kind AND d."scopeKey" = w.key
        LEFT JOIN LATERAL (
          SELECT sum(r."costMicros") AS total FROM "Answer" r
          WHERE r."inputHash" IN (SELECT i->>'inputHash' FROM jsonb_array_elements(s.inputs) i)
        ) cost ON true
        WHERE s."scopeKind" IS NOT NULL OR d."scopeKind" IS NOT NULL ORDER BY w.kind, w.key`),
        q.execute<{
          inputHash: string;
          attempts: number;
          sentAt: string | null;
          answeredAt: string | null;
          lastError: string | null;
          feature: string;
          state: string;
          stage: string;
          waitCause: string | null;
          availableAt: string;
          costMicros: number;
        }>(sql`
        WITH wanted AS (
          SELECT "askId" AS id FROM "AskScope" WHERE "runId" = ${runId}::uuid
          UNION SELECT "askId" FROM "Answer" WHERE "runId" = ${runId}::uuid AND "askId" IS NOT NULL
        )
        SELECT a."inputHash", a.feature, a.attempts,
          (SELECT jsonb_build_object('entity',e.kind,'id',e.shortcode) FROM "AskScope" waiter
           JOIN "RecordKey" k ON k."scopeKind"=waiter."scopeKind" AND k."scopeKey"=waiter."scopeKey"
           JOIN "Entity" e ON e.id=k."entityId" AND e.kind=k.entity
           WHERE waiter."askId"=a.id AND k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
             AND ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL ORDER BY e.shortcode LIMIT 1) AS record, ${isoText(sql`a."sentAt"`)} AS "sentAt", ${isoText(sql`a."answeredAt"`)} AS "answeredAt", a."lastError", CASE WHEN a."cancelledAt" IS NOT NULL THEN ${"abandoned"} ELSE a.state END AS state,
          CASE WHEN a."cancelledAt" IS NOT NULL THEN ${STAGE.ended}
            WHEN a.state = ${ASK.answered} THEN ${STAGE.done}
            WHEN a.state = ${ASK.unknown} OR a.attempts >= a."maxAttempts" THEN ${STAGE.stuck}
            WHEN a."claimToken" IS NOT NULL AND a."claimDeadline" > now() THEN ${STAGE.working}
            ELSE ${STAGE.waiting} END AS stage, a."waitCause", ${isoText(sql`a."availableAt"`)} AS "availableAt",
          coalesce(r."costMicros", 0)::float8 AS "costMicros"
        FROM wanted w JOIN "Ask" a ON a.id = w.id LEFT JOIN "Answer" r ON r."inputHash" = a."inputHash"
        ORDER BY a."createdAt", a.id`),
        loadRunPasses(q, runId),
      ]);
      return runWork.parse({
        scopes: scopes.rows.map((scope) => ({
          ...scope,
          lastError: machineryErrorText(scope.lastError),
          label: scope.firstGap ?? "Record reconciliation",
        })),
        asks: asks.rows.map((ask) => ({
          ...ask,
          lastError: machineryErrorText(ask.lastError),
          label: registry.asks.get(ask.feature)?.label ?? "Answer",
        })),
        passes,
        totalCostMicros: asks.rows.reduce(
          (sum, row) => sum + row.costMicros,
          0,
        ),
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
