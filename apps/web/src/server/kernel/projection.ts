/**
 * The machinery capability's list surface (ADR 0029 section 10, ADR 0025
 * item 11): stage and actor SQL projections for filters and sorts, and a
 * batched loader that a repository's scaffold binds with `bind.ids` to add
 * stage, actor, first-gap label and ETA to a page with one statement. Stage
 * is never stored on the record; `ScopeState` caches the last computed stage
 * per scope and `working` is read from live claims.
 */
import {
  FIELDS_SCOPE,
  QUALITY_SCOPE,
  type MachineryCapability,
} from "@cubby/schemas/kernel/capability";
import { machineryListFields } from "@cubby/schemas/kernel/machinery";
export { machineryListFields } from "@cubby/schemas/kernel/machinery";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { MAX_SCOPE_ATTEMPTS } from "./claim";
import type { KernelRegistry } from "./registry";
import { fromIso, isoText } from "./sql-time";
import { STAGE } from "./vocab";

const ETA_MIN_OBSERVATIONS = 5;

/** Equal-priority scopes order by kind, then key, like the single-record read. */
const SCOPE_ORDER = sql.raw("ord, kind, key");

/**
 * `(kind, key)` of live scopes whose member gap offers an action naming the
 * record as subject or field. The containment tests probe `ScopeState_gaps_idx`
 * per record; the element walk keeps the exact match on the few rows found.
 */
export function memberActionScopes(entity: string, id: SQL): SQL {
  // One bound reference: list rows and page summaries share a parameter budget.
  const naming = (key: SQL) =>
    sql`s.gaps @> jsonb_build_array(jsonb_build_object('actions', jsonb_build_array(jsonb_build_object(${key}, member_ref.value))))`;
  return sql`SELECT s."scopeKind" AS kind, s."scopeKey" AS key
    FROM (SELECT ${entity}::text || ':' || ${id}::text AS value, ${"field"}::text AS field) member_ref
    JOIN "ScopeState" s ON s."mergedIntoKey" IS NULL
      AND (${naming(sql`'subject'`)} OR ${naming(sql`member_ref.field`)})
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(s.gaps) gap
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(gap->'actions','[]'::jsonb)) action
      WHERE gap->>'actor'='you' AND (action->>'subject'=member_ref.value OR action->>member_ref.field=member_ref.value))`;
}

/**
 * `(kind, key, ord)` rows of one record's scopes: owned and member-action
 * scopes share ord 0, then declared, fields and quality scopes. Readers order
 * by `SCOPE_ORDER`, as the single-record read concatenates their gaps.
 */
function recordScopes(capability: MachineryCapability, id: SQL): SQL {
  const parts: SQL[] = [
    sql`SELECT rk."scopeKind" AS kind, rk."scopeKey" AS key, 0 AS ord FROM "RecordKey" rk
      WHERE rk.entity = ${capability.entity} AND rk."entityId" = ${id} AND rk."mergedAt" IS NULL`,
  ];
  parts.push(
    sql`SELECT member.kind, member.key, 0 AS ord FROM (${memberActionScopes(capability.entity, id)}) member`,
  );
  for (const [index, kind] of (capability.scopes ?? []).entries())
    parts.push(sql`SELECT ${kind}::text, ${id}::text, ${index + 1}`);
  if (capability.fields)
    parts.push(
      sql`SELECT ${FIELDS_SCOPE}::text, ${capability.entity}::text || ':' || ${id}::text, ${(capability.scopes?.length ?? 0) + 1}`,
    );
  if (capability.quality)
    parts.push(
      sql`SELECT ${QUALITY_SCOPE}::text, ${capability.entity}::text || ':' || ${id}::text, ${(capability.scopes?.length ?? 0) + 2}`,
    );
  return sql.join(parts, sql` UNION ALL `);
}

/**
 * One scope's ScopeState row, fenced like the ScopeDirty lookup: the keys are
 * known, and an unfenced join lets a correlated read hash all of ScopeState.
 */
const scopeState = (columns: SQL) => sql`LEFT JOIN LATERAL (
        SELECT ${columns} FROM "ScopeState" state
        WHERE state."scopeKind" = scopes.kind AND state."scopeKey" = scopes.key
        OFFSET 0
      ) s ON true`;

/** The record's stage as SQL text, for list filters and sorts. `id` is the row's id column. */
export function machineryStageSql(
  capability: MachineryCapability,
  id: SQL,
): SQL {
  const scopes = recordScopes(capability, id);
  return sql`(
    WITH scopes AS (${scopes}),
    joined AS (
      SELECT scopes.ord, scopes.kind, scopes.key, s.stage, d.attempts,
        (d."claimToken" IS NOT NULL AND d."claimDeadline" > now()) AS live,
        d."scopeKind" IS NOT NULL AS dirty
      FROM scopes
      ${scopeState(sql`state.stage`)}
      -- The scope keys are already known. Fence the lookup so a correlated
      -- stage read cannot scan and hash the whole dirty queue for each record.
      LEFT JOIN LATERAL (
        SELECT dirty."scopeKind", dirty.attempts, dirty."claimToken", dirty."claimDeadline"
        FROM "ScopeDirty" dirty
        WHERE dirty."scopeKind" = scopes.kind AND dirty."scopeKey" = scopes.key
        OFFSET 0
      ) d ON true
    )
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM "RecordKey" rk WHERE rk.entity = ${capability.entity}
        AND rk."entityId" = ${id} AND rk."rejectedAt" IS NOT NULL) THEN ${STAGE.ended}
      WHEN EXISTS (SELECT 1 FROM joined WHERE stage = ${STAGE.stuck} OR attempts >= ${MAX_SCOPE_ATTEMPTS}) THEN ${STAGE.stuck}
      WHEN EXISTS (SELECT 1 FROM joined WHERE live) THEN ${STAGE.working}
      ELSE coalesce(
        (SELECT stage FROM joined WHERE stage IN (${STAGE.needsYou}, ${STAGE.waiting}) ORDER BY ${SCOPE_ORDER} LIMIT 1),
        CASE WHEN EXISTS (SELECT 1 FROM joined WHERE dirty) THEN ${STAGE.waiting} ELSE ${STAGE.done} END)
    END)`;
}

/** The record's next actor as SQL text, or NULL when nothing is owed. */
export function machineryActorSql(
  capability: MachineryCapability,
  id: SQL,
): SQL {
  const scopes = recordScopes(capability, id);
  return sql`(
    WITH scopes AS (${scopes})
    SELECT s."nextActor" FROM scopes
    ${scopeState(sql`state."nextActor"`)}
    WHERE s."nextActor" IS NOT NULL ORDER BY ${SCOPE_ORDER} LIMIT 1)`;
}

/** The fields the list binding adds to each row. */
export type MachineryListRow = z.infer<typeof machineryListFields>;

/** A record with no kernel state: nothing owed. */
export const MACHINERY_DONE: MachineryListRow = {
  attempts: 0,
  costMicros: 0,
  stage: "done",
  nextActor: null,
  firstGap: null,
  eta: null,
};

/**
 * Stage, actor, first-gap label and ETA for a page of records, in one
 * statement: bind it with `bind.ids((page) => loadMachineryRows(...))`.
 */
export async function loadMachineryRows(
  db: Database,
  registry: KernelRegistry,
  capability: MachineryCapability,
  ids: readonly string[],
): Promise<Map<string, MachineryListRow>> {
  if (!ids.length) return new Map();
  const reconcilers = [...registry.reconcilers.values()];
  const ranks = reconcilers.length
    ? sql`VALUES ${sql.join(
        reconcilers.map(
          (reconciler) =>
            sql`(${reconciler.scope}::text, ${registry.rank(reconciler.scope)}::int)`,
        ),
        sql`, `,
      )}`
    : sql`SELECT NULL::text, NULL::int WHERE false`;
  const parts: SQL[] = [
    sql`SELECT page.id, rk."scopeKind" AS kind, rk."scopeKey" AS key, 0 AS ord,
      rk."rejectedAt" IS NOT NULL AS rejected
      FROM page JOIN "RecordKey" rk ON rk.entity = ${capability.entity} AND rk."entityId" = page.id
        AND rk."mergedAt" IS NULL`,
    sql`SELECT page.id, member.kind, member.key, 0, false
      FROM page CROSS JOIN LATERAL (${memberActionScopes(capability.entity, sql`page.id`)}) member`,
  ];
  for (const [index, kind] of (capability.scopes ?? []).entries())
    parts.push(
      sql`SELECT page.id, ${kind}::text, page.id::text, ${index + 1}, false FROM page`,
    );
  if (capability.fields)
    parts.push(
      sql`SELECT page.id, ${FIELDS_SCOPE}::text, ${capability.entity}::text || ':' || page.id::text, ${(capability.scopes?.length ?? 0) + 1}, false FROM page`,
    );
  if (capability.quality)
    parts.push(
      sql`SELECT page.id, ${QUALITY_SCOPE}::text, ${capability.entity}::text || ':' || page.id::text, ${(capability.scopes?.length ?? 0) + 2}, false FROM page`,
    );
  const result = await repositoryQueries(db).execute<{
    id: string;
    attempts: number;
    costMicros: number;
    stage: string;
    actor: string | null;
    firstGap: string | null;
    eta: string | null;
  }>(sql`
    WITH page AS (
      SELECT value::uuid AS id FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
    ), scopes AS (${sql.join(parts, sql` UNION ALL `)}),
    ranks (kind, rank) AS (${ranks}),
    queue AS (
      SELECT d."scopeKind" AS kind, d."scopeKey" AS key, d.attempts,
        (d."claimToken" IS NOT NULL AND d."claimDeadline" > now()) AS live,
        row_number() OVER (PARTITION BY d.lane ORDER BY r.rank, d."availableAt", d.seq) AS position
      FROM "ScopeDirty" d JOIN ranks r ON r.kind = d."scopeKind"
    ), medians AS (
      SELECT "scopeKind" AS kind,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS median, count(*) AS n
      FROM "ScopeState" WHERE "durationMs" IS NOT NULL
        AND "scopeKind" IN (SELECT DISTINCT scopes.kind FROM scopes JOIN queue ON queue.kind = scopes.kind AND queue.key = scopes.key)
      GROUP BY "scopeKind"
    ), joined AS (
      SELECT scopes.*, s.stage, s."nextActor", s."firstGap", s.inputs, queue.position, queue.attempts,
        coalesce(queue.live, false) AS live, medians.median, medians.n
      FROM scopes
      ${scopeState(sql`state.stage, state."nextActor", state."firstGap", state.inputs`)}
      LEFT JOIN queue ON queue.kind = scopes.kind AND queue.key = scopes.key
      LEFT JOIN medians ON medians.kind = scopes.kind
    )
    SELECT id::text AS id, coalesce(max(attempts), 0)::int AS attempts,
      coalesce((SELECT sum(a."costMicros") FROM "Answer" a WHERE a."inputHash" IN
        (SELECT i->>'inputHash' FROM joined cost_scope
          CROSS JOIN LATERAL jsonb_array_elements(cost_scope.inputs) i
          WHERE cost_scope.id = joined.id)), 0)::float8 AS "costMicros",
      CASE
        WHEN bool_or(rejected) THEN ${STAGE.ended}
        WHEN bool_or(stage = ${STAGE.stuck} OR attempts >= ${MAX_SCOPE_ATTEMPTS}) THEN ${STAGE.stuck}
        WHEN bool_or(live) THEN ${STAGE.working}
        ELSE coalesce(
          (array_agg(stage ORDER BY ${SCOPE_ORDER}) FILTER (WHERE stage IN (${STAGE.needsYou}, ${STAGE.waiting})))[1],
          CASE WHEN bool_or(position IS NOT NULL) THEN ${STAGE.waiting} ELSE ${STAGE.done} END)
      END AS stage,
      (array_agg("nextActor" ORDER BY ${SCOPE_ORDER}) FILTER (WHERE "nextActor" IS NOT NULL))[1] AS actor,
      (array_agg("firstGap" ORDER BY ${SCOPE_ORDER}) FILTER (WHERE "firstGap" IS NOT NULL))[1] AS "firstGap",
      ${isoText(sql`min(CASE WHEN position IS NOT NULL AND n >= ${ETA_MIN_OBSERVATIONS}
        THEN (now() + make_interval(secs => position * median / 1000))::timestamp END)`)} AS eta
    FROM joined GROUP BY id`);
  return new Map(
    result.rows.map((row) => [
      row.id,
      machineryListFields.parse({
        attempts: row.attempts,
        costMicros: row.costMicros,
        stage: row.stage,
        nextActor: row.actor,
        firstGap: row.firstGap,
        eta: fromIso(row.eta)?.toISOString() ?? null,
      }),
    ]),
  );
}
