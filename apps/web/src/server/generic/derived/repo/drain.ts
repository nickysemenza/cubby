/**
 * The derived drain (ADR 0021): claim dirty marks, expand fanout marks into
 * their dependents, recompute direct marks through their compute adapters,
 * and publish only changed values. A mark is cleared only when its ticket is
 * unchanged since the claim, so a save that lands during compute keeps the
 * record dirty for the next page.
 */
import { isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type DerivedInput,
  type DerivedPathStep,
  dependentsOf,
  parseTarget,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  type DerivedComputed,
  type DerivedComputes,
  type DerivedSink,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";

type Executor = ReturnType<typeof unwrapDb>;

export { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** Marks claimed per page, and ids per compute call. */
export const DERIVED_PAGE_MARKS = 500;
export const DERIVED_COMPUTE_BATCH = 200;
const FAILURE_BASE_MS = 30_000;
const FAILURE_MAX_MS = 15 * 60_000;

const markRow = z.object({
  target: z.string(),
  ref: z.string(),
  ticket: z.coerce.number(),
  priority: z.coerce.number(),
});
type Mark = z.output<typeof markRow>;

export interface DerivedPagePlan {
  readonly marks: readonly Mark[];
  readonly computed: ReadonlyMap<string, ReadonlyMap<string, DerivedComputed>>;
  readonly sinks: ReadonlyMap<string, { sink: DerivedSink; prepared: unknown }>;
  readonly failed: ReadonlyMap<string, string>;
}

export interface DerivedPublication {
  readonly processed: number;
  readonly changed: number;
  readonly expanded: number;
  /** Entity kinds whose stored values or freshness changed, for reader notifications. */
  readonly categories: readonly string[];
  /** Reconcile marks whose recompute changed the value: an undeclared input. */
  readonly drift: readonly { target: string; count: number }[];
}

/** The ready marks, member edits first. Reads only; publication rechecks tickets. */
export async function claimDerivedMarks(
  db: Database | DrizzleTransaction,
  limit = DERIVED_PAGE_MARKS,
): Promise<Mark[]> {
  const result = await unwrapDb(db).execute(sql`
    SELECT target, ref, ticket, priority FROM "DerivedDirty"
     WHERE "readyAt" <= now()
     ORDER BY priority, "readyAt", ticket
     LIMIT ${limit}`);
  return z.array(markRow).parse(result.rows);
}

const groupByTarget = (marks: readonly Mark[]) => {
  const groups = new Map<string, Mark[]>();
  for (const mark of marks) {
    const group = groups.get(mark.target) ?? [];
    group.push(mark);
    groups.set(mark.target, group);
  }
  return groups;
};

/** Compute every direct mark's value outside the publication transaction. */
export async function prepareDerivedPage(
  db: Database | DrizzleTransaction,
  computes: DerivedComputes,
  marks: readonly Mark[],
): Promise<DerivedPagePlan> {
  const computed = new Map<string, ReadonlyMap<string, DerivedComputed>>();
  const sinks = new Map<string, { sink: DerivedSink; prepared: unknown }>();
  const failed = new Map<string, string>();
  for (const [target, group] of groupByTarget(marks)) {
    const parsed = parseTarget(target);
    if (!parsed || parsed.fanoutInput) continue;
    const compute = computes[parsed.declaration.compute];
    if (!compute) {
      failed.set(target, `No compute adapter ${parsed.declaration.compute}`);
      continue;
    }
    try {
      if (isDerivedSink(compute)) {
        sinks.set(target, {
          sink: compute,
          prepared: await compute.prepare(
            db,
            group.map((mark) => mark.ref),
          ),
        });
        continue;
      }
      const values = new Map<string, DerivedComputed>();
      const ids = group.map((mark) => mark.ref);
      for (let start = 0; start < ids.length; start += DERIVED_COMPUTE_BATCH)
        for (const [id, value] of await compute(
          db,
          ids.slice(start, start + DERIVED_COMPUTE_BATCH),
        ))
          values.set(id, value);
      computed.set(target, values);
    } catch (error) {
      failed.set(
        target,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { marks, computed, sinks, failed };
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

/** Clear exactly the claimed tickets; a newer ticket keeps its mark. */
const clearMarks = async (
  tx: Executor,
  target: string,
  marks: readonly Mark[],
) => {
  await tx.execute(sql`
    DELETE FROM "DerivedDirty" d
     USING jsonb_to_recordset(${JSON.stringify(
       marks.map(({ ref, ticket }) => ({ ref, ticket })),
     )}::jsonb) AS m(ref uuid, ticket bigint)
     WHERE d.target = ${target} AND d.ref = m.ref AND d.ticket = m.ticket`);
};

/** Mark records whose value reads a changed stored value; propagation is priority 1. */
const propagate = async (
  tx: Executor,
  declaration: StoredDerivedDeclaration,
  changedIds: readonly string[],
) => {
  if (changedIds.length === 0) return;
  for (const { declaration: dependent, dependency } of dependentsOf(
    declaration.entity,
    declaration.key,
  )) {
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
    await tx.execute(sql`
      INSERT INTO "DerivedDirty" (target, ref, priority)
      SELECT DISTINCT ${dependent.target}, r.id, 1 FROM (${refs}) AS r(id) WHERE r.id IS NOT NULL
      ON CONFLICT (target, ref) DO UPDATE SET
        ticket = nextval('"DerivedTicket"'),
        priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
        "readyAt" = now()`);
  }
};

/** Publish a sink's prepared output for the marks still current, then clear them. */
const publishSink = async (
  tx: Executor,
  declaration: StoredDerivedDeclaration,
  marks: readonly Mark[],
  { sink, prepared }: { sink: DerivedSink; prepared: unknown },
): Promise<string[]> => {
  const current = await tx.execute(sql`
    SELECT d.ref::text AS ref FROM "DerivedDirty" d
      JOIN jsonb_to_recordset(${JSON.stringify(
        marks.map(({ ref, ticket }) => ({ ref, ticket })),
      )}::jsonb) AS m(ref uuid, ticket bigint)
        ON d.ref = m.ref AND d.ticket = m.ticket
     WHERE d.target = ${declaration.target}
     FOR UPDATE OF d`);
  const ids = z
    .array(z.object({ ref: z.string() }))
    .parse(current.rows)
    .map((row) => row.ref);
  const changed = ids.length ? await sink.publish(tx, ids, prepared) : [];
  await clearMarks(tx, declaration.target, marks);
  return [...changed];
};

/** Write one target's computed values, returning the ids whose value changed. */
const publishValues = async (
  tx: Executor,
  declaration: StoredDerivedDeclaration,
  marks: readonly Mark[],
  values: ReadonlyMap<string, DerivedComputed>,
): Promise<string[]> => {
  const rows = marks
    .filter((mark) => values.has(mark.ref))
    .map((mark) => {
      // SAFETY: filtered to ids present in `values` just above.
      const computed = values.get(mark.ref)!;
      return {
        entityId: mark.ref,
        ticket: mark.ticket,
        value: computed.value ?? null,
        decidedBy: computed.decidedBy ?? null,
        inputHash: computed.inputHash ?? null,
        ...sortColumns(declaration, computed.sort),
      };
    });
  const missing = marks
    .filter((mark) => !values.has(mark.ref))
    .map(({ ref, ticket }) => ({ ref, ticket }));
  const changed: string[] = [];
  if (rows.length > 0) {
    const result = await tx.execute(sql`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS i(
          "entityId" uuid, ticket bigint, value jsonb, "decidedBy" jsonb,
          "inputHash" text, "sortNumber" double precision, "sortDate" timestamp,
          "sortText" text)
      ), current AS (
        SELECT i.* FROM input i
          JOIN "DerivedDirty" d ON d.target = ${declaration.target}
           AND d.ref = i."entityId" AND d.ticket = i.ticket
      ), previous AS (
        SELECT v."entityId", v.value, v."decidedBy" FROM "DerivedValue" v
         WHERE v.key = ${declaration.key}
           AND v."entityId" IN (SELECT "entityId" FROM current)
      ), written AS (
        INSERT INTO "DerivedValue" ("entityId", kind, key, value, "decidedBy",
          "inputHash", "sortNumber", "sortDate", "sortText", "computedAt")
        SELECT c."entityId", ${entityIdentity.kind}, ${declaration.key}, c.value, c."decidedBy",
          c."inputHash", c."sortNumber", c."sortDate", c."sortText", now()
          FROM current c
          JOIN ${entityIdentity} ON ${entityIdentity.id} = c."entityId"
         WHERE ${isNull(entityIdentity.deletedAt)}
        ON CONFLICT ("entityId", key) DO UPDATE SET
          value = EXCLUDED.value, "decidedBy" = EXCLUDED."decidedBy",
          "inputHash" = EXCLUDED."inputHash", "sortNumber" = EXCLUDED."sortNumber",
          "sortDate" = EXCLUDED."sortDate", "sortText" = EXCLUDED."sortText",
          "computedAt" = EXCLUDED."computedAt"
        RETURNING "entityId"
      )
      SELECT w."entityId" AS id FROM written w
        LEFT JOIN previous p ON p."entityId" = w."entityId"
        JOIN current c ON c."entityId" = w."entityId"
       WHERE p."entityId" IS NULL OR p.value IS DISTINCT FROM c.value
          OR p."decidedBy" IS DISTINCT FROM c."decidedBy"`);
    changed.push(
      ...z
        .array(z.object({ id: z.string() }))
        .parse(result.rows)
        .map((row) => row.id),
    );
  }
  if (missing.length > 0) {
    const removed = await tx.execute(sql`
      DELETE FROM "DerivedValue" v
       USING jsonb_to_recordset(${JSON.stringify(missing)}::jsonb) AS m(ref uuid, ticket bigint),
             "DerivedDirty" d
       WHERE v.key = ${declaration.key} AND v."entityId" = m.ref
         AND d.target = ${declaration.target} AND d.ref = m.ref AND d.ticket = m.ticket
      RETURNING v."entityId" AS id`);
    changed.push(
      ...z
        .array(z.object({ id: z.string() }))
        .parse(removed.rows)
        .map((row) => row.id),
    );
  }
  await clearMarks(tx, declaration.target, marks);
  return changed;
};

/** Values reached from `start` along a join path, as one nested subquery. */
const pathSql = (path: readonly DerivedPathStep[], start: SQL): SQL =>
  path.reduce<SQL>(
    (previous, step) =>
      sql`SELECT ${ident(step.to)} FROM ${ident(step.table)} WHERE ${ident(step.from)} IN (${previous})${sql.join(
        Object.entries(step.where ?? {}).map(
          ([column, value]) => sql` AND ${ident(column)} = ${value}`,
        ),
      )}`,
    start,
  );

/** Expand fanout marks into their dependents' marks, then clear them. */
const expandFanout = async (
  tx: Executor,
  declaration: StoredDerivedDeclaration,
  input: DerivedInput,
  target: string,
  marks: readonly Mark[],
): Promise<number> => {
  const refs = sql`SELECT unnest(${uuidArrayParam(marks.map((mark) => mark.ref))})`;
  const dependents = input.path
    ? pathSql(input.path, refs)
    : sql`SELECT d.id FROM ${ident(declaration.table)} d WHERE d.${ident(input.entityColumn)} IN (${refs})`;
  const result = await tx.execute(sql`
    INSERT INTO "DerivedDirty" (target, ref, priority)
    SELECT DISTINCT ${declaration.target}, r.id, 1
      FROM (${dependents}) AS r(id) WHERE r.id IS NOT NULL
    ON CONFLICT (target, ref) DO UPDATE SET
      ticket = nextval('"DerivedTicket"'),
      priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
      "readyAt" = now()
    RETURNING ref`);
  await clearMarks(tx, target, marks);
  return result.rows.length;
};

/** Back off a target whose compute failed; other targets still publish. */
const deferFailed = async (
  tx: Executor,
  target: string,
  marks: readonly Mark[],
  error: string,
) => {
  await tx.execute(sql`
    UPDATE "DerivedDirty" d SET
      attempts = d.attempts + 1,
      "lastError" = ${error.slice(0, 2000)},
      "readyAt" = now() + least(${FAILURE_MAX_MS}::bigint,
        ${FAILURE_BASE_MS}::bigint * (2 ^ d.attempts)::bigint) * interval '1 millisecond'
      FROM jsonb_to_recordset(${JSON.stringify(
        marks.map(({ ref, ticket }) => ({ ref, ticket })),
      )}::jsonb) AS m(ref uuid, ticket bigint)
     WHERE d.target = ${target} AND d.ref = m.ref AND d.ticket = m.ticket`);
};

/** Publish one prepared page in the caller's transaction. */
export async function publishDerivedPage(
  db: Database | DrizzleTransaction,
  plan: DerivedPagePlan,
): Promise<DerivedPublication> {
  const tx = unwrapDb(db);
  let changed = 0;
  let expanded = 0;
  const categories = new Set<string>();
  const drift: { target: string; count: number }[] = [];
  for (const [target, marks] of groupByTarget(plan.marks)) {
    const parsed = parseTarget(target);
    if (!parsed) {
      // A retired declaration's marks have nothing left to compute.
      await clearMarks(tx, target, marks);
      continue;
    }
    const { declaration, fanoutInput } = parsed;
    if (fanoutInput) {
      expanded += await expandFanout(
        tx,
        declaration,
        fanoutInput,
        target,
        marks,
      );
      continue;
    }
    const failure = plan.failed.get(target);
    if (failure !== undefined) {
      await deferFailed(tx, target, marks, failure);
      continue;
    }
    const sink = plan.sinks.get(target);
    const changedIds = sink
      ? await publishSink(tx, declaration, marks, sink)
      : await publishValues(
          tx,
          declaration,
          marks,
          plan.computed.get(target) ?? new Map(),
        );
    changed += changedIds.length;
    const reconciled = new Set(
      marks.filter((mark) => mark.priority === 2).map((mark) => mark.ref),
    );
    const drifted = changedIds.filter((id) => reconciled.has(id)).length;
    if (drifted > 0) drift.push({ target, count: drifted });
    categories.add(declaration.entity);
    await propagate(tx, declaration, changedIds);
  }
  return {
    processed: plan.marks.length,
    changed,
    expanded,
    categories: [...categories].sort(),
    drift,
  };
}

/** Whether ready marks remain after a page. */
export async function derivedMarksReady(
  db: Database | DrizzleTransaction,
): Promise<boolean> {
  const result = await unwrapDb(db).execute(sql`
    SELECT EXISTS (SELECT 1 FROM "DerivedDirty" WHERE "readyAt" <= now()) AS ready`);
  return z.object({ ready: z.boolean() }).parse(result.rows[0]).ready;
}

/** The earliest backoff deadline, for a page that found nothing ready. */
export async function nextDerivedMarkAt(
  db: Database | DrizzleTransaction,
): Promise<Date | null> {
  const result = await unwrapDb(db).execute(sql`
    SELECT min("readyAt") AS next FROM "DerivedDirty"`);
  const next = z
    .object({ next: z.coerce.date().nullable() })
    .parse(result.rows[0]).next;
  return next;
}

/** Mark every stored value at reconcile priority; publication reports drift. */
export async function markAllStoredDerived(
  db: Database | DrizzleTransaction,
  include: (declaration: StoredDerivedDeclaration) => boolean = () => true,
): Promise<number> {
  let marked = 0;
  for (const declaration of storedDerivedDeclarations().filter(include)) {
    const result = await unwrapDb(db).execute(sql`
      INSERT INTO "DerivedDirty" (target, ref, priority)
      SELECT ${declaration.target}, t.id, 2 FROM ${ident(declaration.table)} t
      ON CONFLICT (target, ref) DO NOTHING
      RETURNING ref`);
    marked += result.rows.length;
  }
  return marked;
}
