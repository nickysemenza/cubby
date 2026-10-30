/**
 * The derived drain's adapter (ADR 0021): `defineDrain` claims, fences and
 * settles marks; this module expands fanout marks into their dependents,
 * recomputes direct marks through their compute adapters, and publishes only
 * changed values. A mark clears only while its ticket is unchanged since the
 * claim, so a save that lands during compute keeps the record dirty.
 */
import { inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseChanges } from "~/lib/doorbell";
import type { Database } from "~/server/db";
import {
  type DerivedInput,
  type DerivedPathStep,
  dependentsOf,
  parseTarget,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { derivedValue } from "~/server/db/derived-value-schema";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySql, uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import {
  type DerivedComputed,
  computedDecision,
  validateComputedResult,
  type DerivedComputes,
  type DerivedSink,
  type DerivedSharedPreparation,
  type DerivedFanoutSelection,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import {
  type Drain,
  markWorkFrom,
  observeReadyWork,
  unobservedWork,
  type WorkItem,
  workTicketsWhere,
  workPendingWhere,
} from "~/server/generic/jobs/repo/work-items";

export { DERIVED_DRAIN_JOB_KEY };
export const DERIVED_DRAIN: Drain = {
  key: DERIVED_DRAIN_JOB_KEY,
  kind: "derived.drain",
};

/** Global dependents cannot share preparation with their still-owed upstream publications. */
export function derivedWorkEligible(target: SQL): SQL {
  const blocked = storedDerivedDeclarations().flatMap((declaration) =>
    declaration.dependsOn.flatMap((dependency) =>
      "targetWhere" in dependency
        ? [
            sql`(${target} = ${declaration.target} AND ${workPendingWhere(
              (
                column,
              ) => sql`(${column} = ${`${dependency.entity}.${dependency.key}`}
              OR ${fanoutTargetMatches(column, sql`${`${dependency.entity}.${dependency.key}`}::text`)})`,
            )})`,
          ]
        : [],
    ),
  );
  return blocked.length
    ? sql`NOT (${sql.join(blocked, sql` OR `)})`
    : sql`true`;
}

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);
const fixedTargetRows = (
  table: string,
  where: Readonly<Record<string, string | null>>,
) =>
  sql`SELECT id FROM ${ident(table)} WHERE ${sql.join(
    Object.entries(where).map(([column, value]) =>
      value === null
        ? sql`${ident(column)} IS NULL`
        : sql`${ident(column)} = ${value}`,
    ),
    sql` AND `,
  )}`;

/** Ids per compute call. */
export const DERIVED_COMPUTE_BATCH = 200;
// Heavy adapters retain the original recipe-safe cap. Compact adapters can
// declare a larger batch; mixed pages spend one shared preparation budget.
const DEFAULT_PREPARATION_BATCH = 20;
export function admitDerivedPage({
  items,
  computes,
}: {
  items: readonly WorkItem[];
  computes: DerivedComputes;
}): readonly WorkItem[] {
  let weight = 0;
  let count = 0;
  for (const item of items) {
    const parsed = parseTarget(item.target);
    const adapter =
      parsed && !parsed.fanoutInput
        ? computes[parsed.declaration.compute]
        : undefined;
    const batchSize = Math.max(
      1,
      Math.min(
        DERIVED_COMPUTE_BATCH,
        adapter?.preparationBatchSize ?? DEFAULT_PREPARATION_BATCH,
      ),
    );
    const cost = Math.ceil(DERIVED_COMPUTE_BATCH / batchSize);
    if (weight + cost > DERIVED_COMPUTE_BATCH) break;
    weight += cost;
    count++;
  }
  return items.slice(0, count);
}

/** The doorbell's per-category bound; a larger set refreshes the whole kind. */
const RING_RECORD_LIMIT = 200;
/** Extra scheduling marks covered by one fixed-target expansion, not extra computes. */
const FIXED_FANOUT_COVERAGE_LIMIT = 200;
/** Reconcile priority: a changed value here is drift, an undeclared input. */
const RECONCILE_PRIORITY = 2;

export interface DerivedPagePlan {
  /** Fanout tickets pending when inputs were read; a later one blocks its direct targets. */
  readonly fanoutTickets: readonly number[];
  readonly computed: ReadonlyMap<string, ReadonlyMap<string, DerivedComputed>>;
  readonly sinks: ReadonlyMap<string, { sink: DerivedSink; prepared: unknown }>;
  readonly fanoutSelections: ReadonlyMap<string, DerivedFanoutSelection>;
}

export interface DerivedPublication {
  readonly changed: number;
  readonly expanded: number;
  /** Entity kinds whose stored values or freshness changed, for reader notifications. */
  readonly categories: readonly string[];
  /** The affected records' shortcodes per kind (null past the ring's bound), so readers refetch only those. */
  readonly changes: DatabaseChanges;
  /** Reconcile marks whose recompute changed the value: an undeclared input. */
  readonly drift: readonly { target: string; count: number }[];
}

const groupByTarget = (items: readonly WorkItem[]) => {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const group = groups.get(item.target) ?? [];
    group.push(item);
    groups.set(item.target, group);
  }
  return groups;
};

const declaredTargetsMatch = (targets: readonly string[]) => (column: SQL) =>
  // The page's finite prefix bounds must be visible to the index planner.
  // A correlated EXISTS over JSON targets scans the entire drain instead.
  or(
    ...targets.map((target) =>
      fanoutTargetMatches(column, sql`${target}::text`),
    ),
  ) ?? sql`false`;

/**
 * Compute every direct mark's value outside the publication transaction. A
 * target whose compute fails fails each of its items; the rest publish.
 */
export async function prepareDerivedPage(
  db: Database,
  computes: DerivedComputes,
  items: readonly WorkItem[],
): Promise<{ plan: DerivedPagePlan; failed: Map<WorkItem, unknown> }> {
  // Existing fanouts precede the input reads; only later source edits can
  // invalidate this preparation without having expanded a direct ticket yet.
  const directTargets = [
    ...new Set(
      items
        .filter((item) => !item.target.includes("@"))
        .map((item) => item.target),
    ),
  ];
  const fanoutTickets = directTargets.length
    ? await workTicketsWhere(
        db,
        DERIVED_DRAIN_JOB_KEY,
        declaredTargetsMatch(directTargets),
      )
    : [];
  const computed = new Map<string, ReadonlyMap<string, DerivedComputed>>();
  const sinks = new Map<string, { sink: DerivedSink; prepared: unknown }>();
  const failed = new Map<WorkItem, unknown>();
  const groups = groupByTarget(items);
  const fanoutSelections = new Map<string, DerivedFanoutSelection>();
  for (const target of groups.keys()) {
    const parsed = parseTarget(target);
    const selection = parsed?.fanoutInput?.selection;
    if (!parsed || !selection) continue;
    const adapter = computes[parsed.declaration.compute];
    const select =
      adapter && !isDerivedSink(adapter)
        ? adapter.fanoutSelections?.[selection.key]
        : undefined;
    if (!select || parsed.declaration.publishes !== "derivedValue")
      throw new Error(
        `No value fanout selection ${parsed.declaration.target}.${selection.key}`,
      );
    fanoutSelections.set(target, select);
  }
  const sources = new Map<
    object,
    { adapter: DerivedSharedPreparation; ids: Set<string>; targets: number }
  >();
  for (const [target, group] of groups) {
    const parsed = parseTarget(target);
    if (!parsed || parsed.fanoutInput) continue;
    const compute = computes[parsed.declaration.compute];
    if (!compute || isDerivedSink(compute) || !compute.sharedPreparation)
      continue;
    const adapter = compute.sharedPreparation;
    const source = sources.get(adapter.source) ?? {
      adapter,
      ids: new Set<string>(),
      targets: 0,
    };
    source.targets++;
    for (const item of group) source.ids.add(item.ref);
    sources.set(adapter.source, source);
  }
  const shared = new Map<object, unknown>();
  for (const [key, { adapter, ids, targets }] of sources) {
    if (targets < 2 || ids.size > DERIVED_COMPUTE_BATCH) continue;
    try {
      shared.set(key, await adapter.prepare(db, [...ids]));
    } catch {
      // SILENT: retry each target independently below so a bad sibling cannot poison it.
    }
  }
  for (const [target, group] of groups) {
    const parsed = parseTarget(target);
    if (!parsed || parsed.fanoutInput) continue;
    const compute = computes[parsed.declaration.compute];
    try {
      if (!compute)
        throw new Error(`No compute adapter ${parsed.declaration.compute}`);
      const ids = group.map((item) => item.ref);
      if (isDerivedSink(compute)) {
        sinks.set(target, {
          sink: compute,
          prepared: await compute.prepare(db, ids),
        });
        continue;
      }
      const values = new Map<string, DerivedComputed>();
      for (let start = 0; start < ids.length; start += DERIVED_COMPUTE_BATCH)
        for (const [id, value] of compute.sharedPreparation &&
        shared.has(compute.sharedPreparation.source)
          ? compute.sharedPreparation.project(
              shared.get(compute.sharedPreparation.source),
              ids.slice(start, start + DERIVED_COMPUTE_BATCH),
            )
          : await compute(db, ids.slice(start, start + DERIVED_COMPUTE_BATCH)))
          // Decision validation belongs to target preparation so a malformed
          // outcome cannot abort publication of the page's valid targets.
          values.set(id, validateComputedResult({ target, computed: value }));
      computed.set(target, values);
    } catch (error) {
      for (const item of group) failed.set(item, error);
    }
  }
  return { plan: { fanoutTickets, computed, sinks, fanoutSelections }, failed };
}

/** Source JSON is evidence: malformed references must not fail a drain page. */
const pathReference = (column: string, jsonKey: string | undefined): SQL => {
  if (!jsonKey) return ident(column);
  const value = sql`(${ident(column)} ->> ${jsonKey})`;
  const uuidType = "uuid";
  return sql`CASE WHEN pg_input_is_valid(${value}, ${uuidType}) THEN ${value}::uuid END`;
};

/** Values reached from `start` along a join path, as one nested subquery. */
const pathSql = (path: readonly DerivedPathStep[], start: SQL): SQL =>
  path.reduce<SQL>((previous, step) => {
    if (step.recursive) {
      // Include source IDs even after deletion; canonical compute owns liveness.
      const edge = (column: string) => sql`edge.${ident(column)}`;
      return sql`WITH RECURSIVE derived_path_walk(id, depth, visited) AS (
          SELECT DISTINCT seed.id, 0, ARRAY[seed.id] FROM (${previous}) seed(id)
          WHERE seed.id IS NOT NULL
          UNION ALL
          SELECT ${edge(step.to)}, walk.depth + 1, array_append(walk.visited, ${edge(step.to)})
          FROM ${ident(step.table)} edge JOIN derived_path_walk walk ON ${edge(step.from)} = walk.id
          WHERE walk.depth < ${step.recursive.maxDepth}
            AND ${edge(step.to)} IS NOT NULL AND NOT (${edge(step.to)} = ANY(walk.visited))
            ${sql.join(Object.entries(step.where ?? {}).map(([column, value]) => sql` AND ${edge(column)} = ${value}`))}
        ) SELECT DISTINCT id FROM derived_path_walk`;
    }
    return sql`SELECT ${pathReference(step.to, step.jsonKey)}
        FROM ${ident(step.table)}
        WHERE ${pathReference(step.from, step.fromJsonKey)} IN (${previous})${sql.join(
          Object.entries(step.where ?? {}).map(
            ([column, value]) => sql` AND ${ident(column)} = ${value}`,
          ),
        )}`;
  }, start);

/** Current candidates and prior output references cover both sides of a key edit. */
function selectedTargetRows(
  declaration: StoredDerivedDeclaration,
  input: DerivedInput,
  refs: SQL,
  select: DerivedFanoutSelection,
): SQL {
  const selection = input.selection;
  if (!selection || !input.targetWhere)
    throw new Error(`Invalid fanout selection for ${declaration.target}`);
  const sourceRefs = selection.path ? pathSql(selection.path, refs) : refs;
  const retainedArray = sql`v.value #> ARRAY[${sql.join(
    selection.retained.array.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;
  return sql`SELECT d.id FROM (${fixedTargetRows(declaration.table, input.targetWhere)}) d
    WHERE d.id IN (
      WITH derived_fanout_refs(id) AS MATERIALIZED (${sourceRefs})
      SELECT current_targets.id FROM (${select(sql`SELECT id FROM derived_fanout_refs`)}) current_targets
      UNION
      SELECT v."entityId" FROM ${derivedValue} v
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${retainedArray}) = 'array'
        THEN ${retainedArray} ELSE '[]'::jsonb END) element(value)
      WHERE v.kind = ${declaration.entity} AND v.key = ${declaration.key}
        AND element.value ->> ${selection.retained.key} IN (SELECT id::text FROM derived_fanout_refs)
    )`;
}

/** Records whose stored inputs reach a changed record, per kind, bounded for the doorbell ring. */
class Touched {
  private readonly affected = new Map<string, Set<string>>();
  add(entity: string, ids: readonly string[]) {
    const set = this.affected.get(entity) ?? new Set<string>();
    this.affected.set(entity, set);
    if (set.size > RING_RECORD_LIMIT) return;
    for (const id of ids) {
      set.add(id);
      if (set.size > RING_RECORD_LIMIT) break;
    }
  }
  async publication(
    tx: ReturnType<typeof unwrapDb>,
  ): Promise<Pick<DerivedPublication, "categories" | "changes">> {
    const ids = [...this.affected.values()].flatMap((set) =>
      set.size > RING_RECORD_LIMIT ? [] : [...set],
    );
    const codes = new Map(
      ids.length === 0
        ? []
        : z
            .array(z.object({ id: z.string(), shortcode: z.string() }))
            .parse(
              (
                await tx.execute(sql`
                SELECT id::text AS id, shortcode FROM ${entityIdentity}
                 WHERE id = ANY(${uuidArrayParam(ids)}) AND shortcode IS NOT NULL`)
              ).rows,
            )
            .map((row) => [row.id, row.shortcode]),
    );
    return {
      categories: [...this.affected.keys()].sort(),
      changes: Object.fromEntries(
        [...this.affected].map(([entity, set]) => [
          entity,
          set.size > RING_RECORD_LIMIT
            ? null
            : [...set].flatMap((id) => {
                const code = codes.get(id);
                return code ? [code] : [];
              }),
        ]),
      ),
    };
  }
}

/**
 * Expand the chunk's fanout marks into their dependents' marks. Runs before
 * the drain locks any item: an active writer may own a source mark while
 * waiting on a dependent we write, so the source mark is locked (or skipped)
 * only afterwards, never closing a deadlock cycle.
 */
async function expandFanouts(
  tx: Database,
  items: readonly WorkItem[],
  touched: Touched,
  plan: DerivedPagePlan,
): Promise<Pick<DerivedChunk, "expanded" | "covered">> {
  const fixedTargets = [
    ...new Set(
      items.flatMap(({ target }) => {
        const input = parseTarget(target)?.fanoutInput;
        // A later covered ticket could remove a later chunk's publication fence.
        return input?.targetWhere && !input.selection ? [target] : [];
      }),
    ),
  ];
  const covered = fixedTargets.length
    ? await observeReadyWork(tx, {
        drain: DERIVED_DRAIN_JOB_KEY,
        limit: FIXED_FANOUT_COVERAGE_LIMIT,
        eligible: (column) => inArray(column, fixedTargets),
      })
    : [];
  // Fixed targetWhere ignores source refs. One expansion covers every
  // observed mark for that exact input, at the most urgent source priority.
  const selections = [...groupByTarget([...items, ...covered])].flatMap(
    ([target, group]) => {
      const parsed = parseTarget(target);
      const input = parsed?.fanoutInput;
      if (!parsed || !input) return [];
      const { declaration } = parsed;
      const refs = sql`SELECT unnest(${uuidArrayParam(group.map((item) => item.ref))})`;
      const select = plan.fanoutSelections.get(target);
      const dependents = select
        ? selectedTargetRows(declaration, input, refs, select)
        : input.targetWhere
          ? fixedTargetRows(declaration.table, input.targetWhere)
          : input.paths
            ? sql.join(
                input.paths.map((path) => sql`(${pathSql(path, refs)})`),
                sql` UNION `,
              )
            : input.path
              ? pathSql(input.path, refs)
              : sql`SELECT d.id FROM ${ident(declaration.table)} d WHERE d.${ident(input.entityColumn)} IN (${refs})`;
      return [
        sql`SELECT ${declaration.target}::text, r.id,
        ${Math.min(...group.map((item) => item.priority))}::int
        FROM (${dependents}) r(id)`,
      ];
    },
  );
  if (!selections.length) return { expanded: 0, covered: [] };
  let expanded = 0;
  for (const { target, count, refs } of await markWorkFrom(
    tx,
    DERIVED_DRAIN,
    sql.join(selections, sql` UNION ALL `),
    { sample: RING_RECORD_LIMIT + 1, wake: false },
  )) {
    expanded += count;
    const parsed = parseTarget(target);
    if (parsed) touched.add(parsed.declaration.entity, refs);
  }
  return { expanded, covered };
}

/**
 * Lock a sink's source records without waiting. A member save locks its
 * record's row and then upserts its marks; a sink that writes the record
 * (recipe totals) locks in the same order, so neither side waits on the
 * other. A record that no longer exists has no row to lock; its mark still
 * clears.
 */
async function lockSinkSources(
  tx: ReturnType<typeof unwrapDb>,
  declaration: StoredDerivedDeclaration,
  items: readonly WorkItem[],
): Promise<WorkItem[]> {
  const refs = items.map((item) => item.ref);
  const idRows = z.array(z.object({ id: z.string() }));
  const ids = async (query: SQL) =>
    new Set(idRows.parse((await tx.execute(query)).rows).map((row) => row.id));
  const held = await ids(sql`
    SELECT id::text AS id FROM ${ident(declaration.table)}
     WHERE id = ANY(${uuidArrayParam(refs)}) FOR NO KEY UPDATE SKIP LOCKED`);
  const existing = await ids(sql`
    SELECT id::text AS id FROM ${ident(declaration.table)} WHERE id = ANY(${uuidArrayParam(refs)})`);
  return items.filter((item) => held.has(item.ref) || !existing.has(item.ref));
}

/** A page's per-chunk publication state, reset when a chunk's lock starts. */
export type DerivedChunk = {
  expanded: number;
  touched: Touched;
  covered: readonly WorkItem[];
};
export const derivedChunk = (): DerivedChunk => ({
  expanded: 0,
  touched: new Touched(),
  covered: [],
});

/**
 * The drain's `lock`: expand fanouts, then lock sink sources. Returns the
 * items the chunk may publish; a skipped sink mark stays owed.
 */
export async function lockDerivedChunk(
  db: Database,
  items: readonly WorkItem[],
  plan: DerivedPagePlan,
  chunk: DerivedChunk,
): Promise<WorkItem[]> {
  chunk.touched = new Touched();
  chunk.covered = [];
  const expansion = await expandFanouts(db, items, chunk.touched, plan);
  chunk.expanded = expansion.expanded;
  chunk.covered = expansion.covered;
  const tx = unwrapDb(db);
  const narrowed: WorkItem[] = [];
  for (const [target, group] of groupByTarget(items)) {
    const parsed = parseTarget(target);
    narrowed.push(
      ...(parsed && plan.sinks.has(target)
        ? await lockSinkSources(tx, parsed.declaration, group)
        : group),
    );
  }
  return narrowed;
}

const sortColumns = (
  declaration: StoredDerivedDeclaration,
  sort: number | string | null,
) => ({
  sortNumber:
    declaration.sort === "number" && typeof sort === "number" ? sort : null,
  sortDate: declaration.sort === "date" && sort !== null ? String(sort) : null,
  sortText: declaration.sort === "text" && sort !== null ? String(sort) : null,
});

/** A target's direct marks wait while a fanout newer than the page's reads is pending. */
const blockedByFanout = (target: string, plan: DerivedPagePlan) =>
  unobservedWork(
    (column) => fanoutTargetMatches(column, sql`${target}::text`),
    plan.fanoutTickets,
  );

type ValueGroup = {
  declaration: StoredDerivedDeclaration;
  items: readonly WorkItem[];
  values: ReadonlyMap<string, DerivedComputed>;
};

/**
 * Publish all value targets in one statement over the drain's locked items.
 * Returns the changed ids and the published ids per target; a target blocked
 * behind a newer fanout keeps its previous values and its marks.
 */
async function publishValues(
  tx: ReturnType<typeof unwrapDb>,
  groups: readonly ValueGroup[],
  plan: DerivedPagePlan,
) {
  const rows = groups.flatMap(({ declaration, items, values }) =>
    items.map((item) => {
      const computed = values.get(item.ref);
      return {
        target: declaration.target,
        key: declaration.key,
        entityId: item.ref,
        hasValue: computed !== undefined,
        value: computed?.value ?? null,
        decidedBy: computed === undefined ? null : computedDecision(computed),
        inputHash: computed?.inputHash ?? null,
        ...sortColumns(declaration, computed?.sort ?? null),
      };
    }),
  );
  // These read-only barriers precede the same value write. Keep each target's
  // indexable prefix bounds while sharing their statement and snapshot.
  const blocked = new Set(
    z
      .array(z.object({ target: z.string() }))
      .parse(
        (
          await tx.execute(
            sql.join(
              groups.map(
                ({ declaration }) =>
                  sql`SELECT ${declaration.target}::text AS target
                    WHERE ${blockedByFanout(declaration.target, plan)}`,
              ),
              sql` UNION ALL `,
            ),
          )
        ).rows,
      )
      .map(({ target }) => target),
  );
  const publishable = rows.filter((row) => !blocked.has(row.target));
  const published = new Map<string, string[]>();
  for (const row of publishable) {
    const ids = published.get(row.target) ?? [];
    ids.push(row.entityId);
    published.set(row.target, ids);
  }
  const changed = new Map<string, string[]>();
  if (!publishable.length) return { changed, published };
  // Avoid planning a second value-table writer when there is nothing to remove.
  const hasMissing = publishable.some((row) => !row.hasValue);
  const result = await tx.execute(sql`
    WITH current AS MATERIALIZED (
      SELECT i.*, v."entityId" AS "previousId", v.value AS "previousValue",
        v."decidedBy" AS "previousDecidedBy", ${entityIdentity.kind} AS kind,
        (${entityIdentity.id} IS NOT NULL AND ${isNull(entityIdentity.deletedAt)}) AS live
        FROM jsonb_to_recordset(${JSON.stringify(publishable)}::jsonb) AS i(
          target text, key text, "entityId" uuid, "hasValue" boolean, value jsonb,
          "decidedBy" jsonb, "inputHash" text, "sortNumber" double precision,
          "sortDate" timestamp, "sortText" text)
        LEFT JOIN "DerivedValue" v ON v."entityId" = i."entityId" AND v.key = i.key
        LEFT JOIN ${entityIdentity} ON ${entityIdentity.id} = i."entityId"
    ), written AS (
      INSERT INTO "DerivedValue" ("entityId", kind, key, value, "decidedBy",
        "inputHash", "sortNumber", "sortDate", "sortText", "computedAt")
      SELECT c."entityId", c.kind, c.key, c.value, c."decidedBy",
        c."inputHash", c."sortNumber", c."sortDate", c."sortText", now()
        FROM current c
       WHERE c."hasValue" AND c.live
       ORDER BY c."entityId", c.key
      ON CONFLICT ("entityId", key) DO UPDATE SET
        value = EXCLUDED.value, "decidedBy" = EXCLUDED."decidedBy",
        "inputHash" = EXCLUDED."inputHash", "sortNumber" = EXCLUDED."sortNumber",
        "sortDate" = EXCLUDED."sortDate", "sortText" = EXCLUDED."sortText",
        "computedAt" = EXCLUDED."computedAt"
    )${
      hasMissing
        ? sql`, removed AS (
      DELETE FROM "DerivedValue" v USING current c
       WHERE NOT c."hasValue" AND v.key = c.key
         AND v."entityId" = c."entityId"
      RETURNING v."entityId", c.target
    )`
        : sql``
    }
    SELECT c.target, c."entityId" AS id FROM current c
     WHERE c."hasValue" AND c.live AND (
       c."previousId" IS NULL OR c."previousValue" IS DISTINCT FROM c.value
       OR c."previousDecidedBy" IS DISTINCT FROM c."decidedBy")
    ${hasMissing ? sql`UNION ALL SELECT target, "entityId" AS id FROM removed` : sql``}`);
  for (const { target, id } of z
    .array(z.object({ target: z.string(), id: z.string() }))
    .parse(result.rows)) {
    const ids = changed.get(target) ?? [];
    ids.push(id);
    changed.set(target, ids);
  }
  return { changed, published };
}

/** Mark records whose value reads a changed stored value; propagation is priority 1. */
async function propagate(
  db: Database,
  declaration: StoredDerivedDeclaration,
  changedIds: readonly string[],
) {
  if (changedIds.length === 0) return;
  const selections = dependentsOf(declaration.entity, declaration.key).map(
    ({ declaration: dependent, dependency }) => {
      const refs =
        "targetWhere" in dependency
          ? fixedTargetRows(dependent.table, dependency.targetWhere)
          : "path" in dependency
            ? pathSql(
                dependency.path,
                sql`SELECT unnest(${uuidArrayParam(changedIds)})`,
              )
            : "through" in dependency
              ? sql`SELECT l.${ident(dependency.through.dependent)} AS id
                FROM ${ident(dependency.through.table)} l
               WHERE l.${ident(dependency.through.source)} = ANY(${uuidArrayParam(changedIds)})
                 ${sql.join(
                   Object.entries(dependency.through.where ?? {}).map(
                     ([column, value]) =>
                       sql` AND l.${ident(column)} = ${value}`,
                   ),
                 )}`
              : sql`SELECT d.id FROM ${ident(dependent.table)} d
                JOIN ${ident(declaration.table)} s
                  ON s.${ident(dependency.sourceColumn)} = d.${ident(dependency.entityColumn)}
               WHERE s.id = ANY(${uuidArrayParam(changedIds)})`;
      return sql`SELECT ${dependent.target}::text, r.id, 1 FROM (${refs}) AS r(id)`;
    },
  );
  if (selections.length)
    await markWorkFrom(
      db,
      DERIVED_DRAIN,
      sql.join(selections, sql` UNION ALL `),
      {
        wake: false,
      },
    );
}

/**
 * Publish one chunk of held items in the drain's fenced transaction. Fanout
 * marks were expanded by `lockDerivedChunk`; retired declarations' marks have
 * nothing left to compute and simply clear. Returns the items that stay owed
 * (blocked behind a newer fanout) and what readers must refetch.
 */
export async function publishDerivedChunk(
  db: Database,
  items: readonly WorkItem[],
  plan: DerivedPagePlan,
  chunk: DerivedChunk,
): Promise<
  DerivedPublication & { retain: WorkItem[]; covered: readonly WorkItem[] }
> {
  const tx = unwrapDb(db);
  const { touched } = chunk;
  const groups = groupByTarget(items);
  const valueGroups: ValueGroup[] = [];
  for (const [target, group] of groups) {
    const parsed = parseTarget(target);
    if (parsed && !parsed.fanoutInput && !plan.sinks.has(target))
      valueGroups.push({
        declaration: parsed.declaration,
        items: group,
        values: plan.computed.get(target) ?? new Map(),
      });
  }
  const values = valueGroups.length
    ? await publishValues(tx, valueGroups, plan)
    : { changed: new Map<string, string[]>(), published: new Map() };
  const retain: WorkItem[] = [];
  const drift: { target: string; count: number }[] = [];
  let changed = 0;
  for (const [target, group] of groups) {
    const parsed = parseTarget(target);
    if (!parsed || parsed.fanoutInput) continue;
    const { declaration } = parsed;
    const sink = plan.sinks.get(target);
    let changedIds: readonly string[];
    let publishedIds: ReadonlySet<string>;
    if (sink) {
      const [row] = z
        .array(z.object({ blocked: z.boolean() }))
        .parse(
          (
            await tx.execute(
              sql`SELECT ${blockedByFanout(target, plan)} AS blocked`,
            )
          ).rows,
        );
      const ids = row?.blocked ? [] : group.map((item) => item.ref);
      // Sinks reuse repository writers, which take the Database handle.
      changedIds = ids.length
        ? await sink.sink.publish(db, ids, sink.prepared)
        : [];
      publishedIds = new Set(ids);
    } else {
      changedIds = values.changed.get(target) ?? [];
      publishedIds = new Set(values.published.get(target) ?? []);
    }
    retain.push(...group.filter((item) => !publishedIds.has(item.ref)));
    const published = group.filter((item) => publishedIds.has(item.ref));
    if (!published.length) continue;
    changed += changedIds.length;
    const reconciled = new Set(
      published
        .filter((item) => item.priority === RECONCILE_PRIORITY)
        .map((item) => item.ref),
    );
    const drifted = changedIds.filter((id) => reconciled.has(id)).length;
    if (drifted > 0) drift.push({ target, count: drifted });
    // Every published record's freshness changed, whether or not its value did.
    touched.add(
      declaration.entity,
      published.map((item) => item.ref),
    );
    await propagate(db, declaration, changedIds);
  }
  return {
    changed,
    expanded: chunk.expanded,
    drift,
    retain,
    covered: chunk.covered,
    ...(await touched.publication(tx)),
  };
}

/** Mark every stored value at reconcile priority; publication reports drift. */
export async function markAllStoredDerived(
  db: RepositoryQueryInput,
  include: (declaration: StoredDerivedDeclaration) => boolean = () => true,
  /** Only records whose id hashes to `index` of `count` buckets. */
  slice?: { readonly index: number; readonly count: number },
): Promise<number> {
  let marked = 0;
  for (const declaration of storedDerivedDeclarations().filter(include)) {
    const rows = await markWorkFrom(
      db,
      DERIVED_DRAIN,
      sql`SELECT ${declaration.target}::text, t.id, ${RECONCILE_PRIORITY}::int
        FROM ${ident(declaration.table)} t
        ${slice ? sql`WHERE mod(abs(hashtext(t.id::text)), ${slice.count}) = ${slice.index}` : sql``}`,
      { existing: "keep" },
    );
    marked += rows.reduce((total, row) => total + row.count, 0);
  }
  return marked;
}

/** Calendar expiry reuses dirty marks and the existing minute drain, without resetting failures. */
export async function markExpiredClockDerived(
  db: RepositoryQueryInput,
): Promise<number> {
  const targets = storedDerivedDeclarations()
    .filter(
      (entry) =>
        entry.clock === "householdDay" && entry.publishes === "derivedValue",
    )
    .map(({ target, key, entity }) => ({ target, key, entity }));
  if (targets.length === 0) return 0;
  const rows = await markWorkFrom(
    db,
    DERIVED_DRAIN,
    sql`SELECT k.target, v."entityId", ${RECONCILE_PRIORITY}::int
        FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS k(target text, key text, entity text)
        JOIN "DerivedValue" v ON v.key = k.key
        JOIN ${entityIdentity} ON ${entityIdentity.id} = v."entityId" AND ${entityIdentity.kind} = k.entity AND ${notDeleted(entityIdentity)}
       WHERE ${householdDaySql(sql`v."computedAt"`)} < ${householdDaySql(sql`now() AT TIME ZONE 'UTC'`)}`,
    { existing: "keep" },
  );
  return rows.reduce((total, row) => total + row.count, 0);
}
