/**
 * The derived drain's adapter (ADR 0021): `defineDrain` claims, fences and
 * settles marks; this module expands fanout marks into their dependents,
 * recomputes direct marks through their compute adapters, and publishes only
 * changed values. A mark clears only while its ticket is unchanged since the
 * claim, so a save that lands during compute keeps the record dirty.
 */
import { isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseChanges } from "~/lib/doorbell";
import type { Database } from "~/server/db";
import {
  type DerivedPathStep,
  dependentsOf,
  parseTarget,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
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
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import {
  type Drain,
  markWorkFrom,
  unobservedWork,
  type WorkItem,
  workTicketsWhere,
} from "~/server/generic/jobs/repo/work-items";

export { DERIVED_DRAIN_JOB_KEY };
export const DERIVED_DRAIN: Drain = {
  key: DERIVED_DRAIN_JOB_KEY,
  kind: "derived.drain",
};

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** Ids per compute call. */
export const DERIVED_COMPUTE_BATCH = 200;
/** The doorbell's per-category bound; a larger set refreshes the whole kind. */
const RING_RECORD_LIMIT = 200;
/** Reconcile priority: a changed value here is drift, an undeclared input. */
const RECONCILE_PRIORITY = 2;

export interface DerivedPagePlan {
  /** Fanout tickets pending when inputs were read; a later one blocks its direct targets. */
  readonly fanoutTickets: readonly number[];
  readonly computed: ReadonlyMap<string, ReadonlyMap<string, DerivedComputed>>;
  readonly sinks: ReadonlyMap<string, { sink: DerivedSink; prepared: unknown }>;
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
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb) declared(target)
    WHERE ${fanoutTargetMatches(column, sql`declared.target`)})`;

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
  for (const [target, group] of groupByTarget(items)) {
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
        for (const [id, value] of await compute(
          db,
          ids.slice(start, start + DERIVED_COMPUTE_BATCH),
        ))
          // Decision validation belongs to target preparation so a malformed
          // outcome cannot abort publication of the page's valid targets.
          values.set(id, validateComputedResult({ target, computed: value }));
      computed.set(target, values);
    } catch (error) {
      for (const item of group) failed.set(item, error);
    }
  }
  return { plan: { fanoutTickets, computed, sinks }, failed };
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
  path.reduce<SQL>(
    (previous, step) => sql`SELECT ${pathReference(step.to, step.jsonKey)}
      FROM ${ident(step.table)}
      WHERE ${pathReference(step.from, step.fromJsonKey)} IN (${previous})${sql.join(
        Object.entries(step.where ?? {}).map(
          ([column, value]) => sql` AND ${ident(column)} = ${value}`,
        ),
      )}`,
    start,
  );

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
): Promise<number> {
  const selections = [...groupByTarget(items)].flatMap(([target, group]) => {
    const parsed = parseTarget(target);
    const input = parsed?.fanoutInput;
    if (!parsed || !input) return [];
    const { declaration } = parsed;
    const refs = sql`SELECT unnest(${uuidArrayParam(group.map((item) => item.ref))})`;
    const dependents = input.targetWhere
      ? sql`SELECT id FROM ${ident(declaration.table)} WHERE ${sql.join(
          Object.entries(input.targetWhere).map(([column, value]) =>
            value === null
              ? sql`${ident(column)} IS NULL`
              : sql`${ident(column)} = ${value}`,
          ),
          sql` AND `,
        )}`
      : input.path
        ? pathSql(input.path, refs)
        : sql`SELECT d.id FROM ${ident(declaration.table)} d WHERE d.${ident(input.entityColumn)} IN (${refs})`;
    return [
      sql`SELECT ${declaration.target}::text, r.id,
        ${Math.min(...group.map((item) => item.priority))}::int
        FROM (${dependents}) r(id)`,
    ];
  });
  if (!selections.length) return 0;
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
  return expanded;
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
export type DerivedChunk = { expanded: number; touched: Touched };
export const derivedChunk = (): DerivedChunk => ({
  expanded: 0,
  touched: new Touched(),
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
  chunk.expanded = await expandFanouts(db, items, chunk.touched);
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
  const blocked = new Set<string>();
  for (const { declaration } of groups) {
    const [row] = z
      .array(z.object({ blocked: z.boolean() }))
      .parse(
        (
          await tx.execute(
            sql`SELECT ${blockedByFanout(declaration.target, plan)} AS blocked`,
          )
        ).rows,
      );
    if (row?.blocked) blocked.add(declaration.target);
  }
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
        "path" in dependency
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
): Promise<DerivedPublication & { retain: WorkItem[] }> {
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
