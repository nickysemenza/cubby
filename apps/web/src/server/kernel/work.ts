/** Batched reads for Needs you and the work carrying a Run. */
import { passWork, type PassWork } from "@cubby/schemas/kernel/machinery";
import {
  needsYouPage,
  runWork,
  type NeedsYouPage,
  type RunWork,
} from "@cubby/schemas/kernel/work";
import { getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";

import { askOutcomes } from "./ask-gap";
import { passOrder } from "./claim";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { ASK, STAGE } from "./vocab";

const publicEntity = alias(entityIdentity, "e");

type Q = Pick<RepositoryQueryClient, "execute">;

export async function loadRunPasses(q: Q, runId: string): Promise<PassWork[]> {
  const result = await q.execute<{
    name: string;
    key: string;
    stage: string;
    availableAt: string;
    waitCause: string | null;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    doneAt: string | null;
    cancelledAt: string | null;
  }>(sql`
    SELECT name, key,
      CASE WHEN "cancelledAt" IS NOT NULL THEN ${STAGE.ended}
        WHEN "doneAt" IS NOT NULL THEN ${STAGE.done}
        WHEN attempts >= "maxAttempts" THEN ${STAGE.stuck}
        WHEN "claimToken" IS NOT NULL AND "claimDeadline" > now() THEN ${STAGE.working}
        ELSE ${STAGE.waiting} END AS stage,
      ${isoText(sql`"availableAt"`)} AS "availableAt", "waitCause", attempts, "maxAttempts", "lastError",
      ${isoText(sql`"doneAt"`)} AS "doneAt", ${isoText(sql`"cancelledAt"`)} AS "cancelledAt"
    FROM "Pass" WHERE "runId" = ${runId}::uuid ORDER BY ${passOrder()}`);
  return result.rows.map((row) => passWork.parse({ ...row, costMicros: 0 }));
}

/** One row per public record with a member-supplied gap, oldest first; no per-record reads. */
export async function readNeedsYou(
  db: Database,
  registry: KernelRegistry,
  options: { limit?: number; offset?: number } = {},
): Promise<NeedsYouPage> {
  const consumers = [...registry.machinery.values()].flatMap((capability) =>
    (capability.scopes ?? []).map((kind) => ({
      entity: capability.entity,
      kind,
    })),
  );
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const result = await repositoryQueries(db).execute<{
    items: unknown;
    count: number;
  }>(sql`
    WITH members AS (
      SELECT s.*, jsonb_path_query_first(s.gaps, '$[*] ? (@.actor == "you")') AS gap
      FROM "ScopeState" s WHERE s."mergedIntoKey" IS NULL
    ), records AS (
      SELECT DISTINCT m."scopeKind", m."scopeKey", e.kind AS entity, e.shortcode,
        m.stage, m.gap->>${"input"} AS "firstGap", m.gap->'actions' AS actions, m.gap->>'since' AS since
      FROM members m JOIN "RecordKey" k
        ON k."scopeKind" = m."scopeKind" AND k."scopeKey" = m."scopeKey"
        AND k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
      JOIN "Entity" e ON e.id = k."entityId" AND e.kind = k.entity
      WHERE ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL
      UNION
      SELECT m."scopeKind", m."scopeKey", e.kind, e.shortcode, m.stage,
        m.gap->>${"input"}, m.gap->'actions', m.gap->>'since'
      FROM members m JOIN "Entity" e ON m."scopeKey" = e.kind || ':' || e.id::text
      WHERE m."scopeKind" IN ('fields', 'quality')
        AND ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL
      UNION
      SELECT m."scopeKind", m."scopeKey", e.kind, e.shortcode, m.stage, m.gap->>${"input"}, m.gap->'actions', m.gap->>'since'
      FROM members m JOIN jsonb_to_recordset(${JSON.stringify(consumers)}::jsonb) consumer(entity text, kind text) ON consumer.kind = m."scopeKind"
      JOIN "Entity" e ON e.kind = consumer.entity AND e.id::text = m."scopeKey"
      WHERE ${notDeleted(publicEntity)} AND e."mergedIntoId" IS NULL
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY entity, shortcode ORDER BY ("firstGap" IS NULL), since NULLS LAST, "scopeKind", "scopeKey") AS rank,
        min(CASE stage WHEN ${STAGE.ended} THEN 0 WHEN ${STAGE.stuck} THEN 1
          WHEN ${STAGE.working} THEN 2 WHEN ${STAGE.needsYou} THEN 3 WHEN ${STAGE.waiting} THEN 4 ELSE 5 END)
          OVER (PARTITION BY entity, shortcode) AS severity
      FROM records
    ), eligible AS (
      SELECT entity, shortcode,
        CASE severity WHEN 0 THEN ${STAGE.ended} WHEN 1 THEN ${STAGE.stuck} WHEN 2 THEN ${STAGE.working}
          WHEN 3 THEN ${STAGE.needsYou} WHEN 4 THEN ${STAGE.waiting} ELSE ${STAGE.done} END AS stage,
        "firstGap", actions, since FROM ranked WHERE rank = 1 AND shortcode IS NOT NULL AND "firstGap" IS NOT NULL
    ), page AS (
      SELECT * FROM eligible ORDER BY since NULLS LAST, entity, shortcode LIMIT ${limit} OFFSET ${offset}
    )
    SELECT (SELECT count(*)::int FROM eligible) AS count,
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY since NULLS LAST, entity, shortcode) FROM page), '[]'::jsonb) AS items`);
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
        SELECT a."inputHash", a.feature, CASE WHEN a."cancelledAt" IS NOT NULL THEN ${askOutcomes[2]} ELSE a.state END AS state,
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
        scopes: scopes.rows,
        asks: asks.rows,
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
