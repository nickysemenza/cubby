/**
 * The derived drain (ADR 0021): claim dirty marks, expand fanout marks into
 * their dependents, recompute direct marks through their compute adapters,
 * and publish only changed values. A mark is cleared only when its ticket is
 * unchanged since the claim, so a save that lands during compute keeps the
 * record dirty for the next page.
 */
import { isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseChanges } from "~/lib/doorbell";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type DerivedPathStep,
  dependentsOf,
  parseTarget,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySql, uuidArrayParam } from "~/server/db/helpers/query";
import { findPgError } from "~/server/errors/db-errors";
import {
  type DerivedComputed,
  computedDecision,
  validateComputedResult,
  type DerivedComputes,
  type DerivedSink,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";

type Executor = ReturnType<typeof unwrapDb>;

export { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** Marks claimed per page, and ids per compute call. */
const DERIVED_PAGE_MARKS = 500;
export const DERIVED_COMPUTE_BATCH = 200;
const FAILURE_BASE_MS = 30_000;
/** The doorbell's per-category bound; a larger set refreshes the whole kind. */
const RING_RECORD_LIMIT = 200;
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
  readonly fanoutTickets: readonly number[];
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
  /** The affected records' shortcodes per kind (null past the ring's bound), so readers refetch only those. */
  readonly changes: DatabaseChanges;
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
  db: Database,
  computes: DerivedComputes,
  marks: readonly Mark[],
): Promise<DerivedPagePlan> {
  // Existing fanouts precede the input reads; only later source edits can
  // invalidate this preparation without having expanded a direct ticket yet.
  const directTargets = [
    ...new Set(
      marks
        .filter((mark) => !mark.target.includes("@"))
        .map((mark) => mark.target),
    ),
  ];
  const fanoutTickets =
    directTargets.length === 0
      ? []
      : z
          .array(z.object({ ticket: z.coerce.number() }))
          .parse(
            (
              await unwrapDb(db).execute(sql`
      SELECT ticket FROM "DerivedDirty"
       WHERE strpos(target, '@') > 0
         AND split_part(target, '@', 1) = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(directTargets)}::jsonb)))`)
            ).rows,
          )
          .map((mark) => mark.ticket);
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
          // Decision validation belongs to target preparation so a malformed
          // outcome cannot abort publication of the page's valid targets.
          values.set(id, validateComputedResult({ target, computed: value }));
      computed.set(target, values);
    } catch (error) {
      failed.set(
        target,
        error instanceof Error ? errorChainMessage(error) : String(error),
      );
    }
  }
  return { marks, fanoutTickets, computed, sinks, failed };
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
/**
 * The marks this publication may write and clear, locked without waiting.
 * A member save locks its record's row and then upserts its marks; a sink
 * that writes the record (recipe totals) locks in the same order, so neither
 * side ever waits on the other. Skipped marks keep their ticket and drain on a
 * later page.
 */
const lockPublishableMarks = async (
  tx: Executor,
  declaration: StoredDerivedDeclaration,
  marks: readonly Mark[],
  fanoutTickets: readonly number[],
): Promise<Mark[]> => {
  let candidates: readonly Mark[] = marks;
  if (marks.length > 0) {
    const refs = marks.map((mark) => mark.ref);
    const idRows = z.array(z.object({ id: z.string() }));
    const held = new Set(
      idRows
        .parse(
          (
            await tx.execute(sql`
              SELECT id::text AS id FROM ${ident(declaration.table)}
               WHERE id = ANY(${uuidArrayParam(refs)}) FOR NO KEY UPDATE SKIP LOCKED`)
          ).rows,
        )
        .map((row) => row.id),
    );
    const existing = new Set(
      idRows
        .parse(
          (
            await tx.execute(sql`
              SELECT id::text AS id FROM ${ident(declaration.table)}
               WHERE id = ANY(${uuidArrayParam(refs)})`)
          ).rows,
        )
        .map((row) => row.id),
    );
    // A record that no longer exists has no row to lock; its mark still clears.
    candidates = marks.filter(
      (mark) => held.has(mark.ref) || !existing.has(mark.ref),
    );
  }
  if (candidates.length === 0) return [];
  const locked = await tx.execute(sql`
    SELECT d.ref::text AS ref FROM "DerivedDirty" d
      JOIN jsonb_to_recordset(${JSON.stringify(
        candidates.map(({ ref, ticket }) => ({ ref, ticket })),
      )}::jsonb) AS m(ref uuid, ticket bigint)
        ON d.ref = m.ref AND d.ticket = m.ticket
     WHERE d.target = ${declaration.target}
       AND NOT EXISTS (
         SELECT 1 FROM "DerivedDirty" pending
          WHERE starts_with(pending.target, ${`${declaration.target}@`})
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(fanoutTickets)}::jsonb) observed(ticket)
              WHERE observed.ticket::bigint = pending.ticket
            )
       )
     FOR UPDATE OF d SKIP LOCKED`);
  const refs = new Set(
    z
      .array(z.object({ ref: z.string() }))
      .parse(locked.rows)
      .map((row) => row.ref),
  );
  return candidates.filter((mark) => refs.has(mark.ref));
};

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
  db: Database,
  declaration: StoredDerivedDeclaration,
  marks: readonly Mark[],
  { sink, prepared }: { sink: DerivedSink; prepared: unknown },
  fanoutTickets: readonly number[],
): Promise<string[]> => {
  const tx = unwrapDb(db);
  const held = await lockPublishableMarks(
    tx,
    declaration,
    marks,
    fanoutTickets,
  );
  const ids = held.map((mark) => mark.ref);
  // Sinks reuse repository writers, which take the Database handle.
  const changed = ids.length ? await sink.publish(db, ids, prepared) : [];
  await clearMarks(tx, declaration.target, held);
  return [...changed];
};

type ValueGroup = {
  fanoutTickets: readonly number[];
  declaration: StoredDerivedDeclaration;
  marks: readonly Mark[];
  values: ReadonlyMap<string, DerivedComputed>;
};

/** Publish all value targets together; each row keeps its own mark and value key. */
const publishValues = async (
  tx: Executor,
  groups: readonly ValueGroup[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const rows = groups.flatMap(({ declaration, marks, values }) =>
    marks.map((mark) => {
      const computed = values.get(mark.ref);
      return {
        target: declaration.target,
        key: declaration.key,
        entityId: mark.ref,
        ticket: mark.ticket,
        hasValue: computed !== undefined,
        value: computed?.value ?? null,
        decidedBy: computed === undefined ? null : computedDecision(computed),
        inputHash: computed?.inputHash ?? null,
        ...sortColumns(declaration, computed?.sort ?? null),
      };
    }),
  );

  // Avoid planning a second value-table writer when there is nothing to remove.
  const hasMissing = rows.some((row) => !row.hasValue);
  // Lock, publish and clear the observed tickets in one statement. Every write
  // depends on the locked set, so busy or replaced marks keep both their work
  // and their previous values. The caller isolates rejected batches by target.
  const result = await tx.execute(sql`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS i(
        target text, key text, "entityId" uuid, ticket bigint, "hasValue" boolean, value jsonb,
        "decidedBy" jsonb, "inputHash" text, "sortNumber" double precision,
        "sortDate" timestamp, "sortText" text)
    ), current AS MATERIALIZED (
      SELECT i.*, v."entityId" AS "previousId", v.value AS "previousValue",
        v."decidedBy" AS "previousDecidedBy", ${entityIdentity.kind} AS kind,
        (${entityIdentity.id} IS NOT NULL AND ${isNull(entityIdentity.deletedAt)}) AS live
        FROM input i
        JOIN "DerivedDirty" d ON d.target = i.target
         AND d.ref = i."entityId" AND d.ticket = i.ticket
        LEFT JOIN "DerivedValue" v ON v."entityId" = i."entityId" AND v.key = i.key
        LEFT JOIN ${entityIdentity} ON ${entityIdentity.id} = i."entityId"
       WHERE NOT EXISTS (
         -- A source edit can precede dependent ticket expansion. Keep the
         -- previous result and direct work until that fanout has expanded.
         SELECT 1 FROM "DerivedDirty" pending
          WHERE starts_with(pending.target, i.target || '@')
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(groups[0]?.fanoutTickets ?? [])}::jsonb) observed(ticket)
              WHERE observed.ticket::bigint = pending.ticket
            )
       )
       ORDER BY d.target, d.ref
       FOR UPDATE OF d SKIP LOCKED
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
    ), ${
      hasMissing
        ? sql`removed AS (
      DELETE FROM "DerivedValue" v USING current c
       WHERE NOT c."hasValue" AND v.key = c.key
         AND v."entityId" = c."entityId"
      RETURNING v."entityId", c.target
    ),`
        : sql``
    } cleared AS (
      DELETE FROM "DerivedDirty" d USING current c
       WHERE d.target = c.target
         AND d.ref = c."entityId" AND d.ticket = c.ticket
    )
    SELECT c.target, c."entityId" AS id FROM current c
     WHERE c."hasValue" AND c.live AND (
       c."previousId" IS NULL OR c."previousValue" IS DISTINCT FROM c.value
       OR c."previousDecidedBy" IS DISTINCT FROM c."decidedBy")
    ${hasMissing ? sql`UNION ALL SELECT target, "entityId" AS id FROM removed` : sql``}`);
  const changed = new Map<string, string[]>();
  for (const { target, id } of z
    .array(z.object({ target: z.string(), id: z.string() }))
    .parse(result.rows)) {
    const ids = changed.get(target) ?? [];
    ids.push(id);
    changed.set(target, ids);
  }
  return changed;
};

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

/** Expand the page's fanout groups and clear their observed tickets in one round trip. */
const expandFanouts = async (tx: Executor, marks: readonly Mark[]) => {
  const groups = [...groupByTarget(marks)].flatMap(([target, group]) => {
    const parsed = parseTarget(target);
    return parsed?.fanoutInput
      ? [
          {
            target,
            marks: group,
            declaration: parsed.declaration,
            input: parsed.fanoutInput,
          },
        ]
      : [];
  });
  if (!groups.length) return [];
  const selections = groups.map(({ declaration, input, marks: group }) => {
    const refs = sql`SELECT unnest(${uuidArrayParam(group.map((mark) => mark.ref))})`;
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
    return sql`SELECT ${declaration.target}::text AS target, r.id AS ref,
      ${Math.min(...group.map((mark) => mark.priority))}::int AS priority
      FROM (${dependents}) r(id) WHERE r.id IS NOT NULL`;
  });
  const observed = groups.flatMap(({ target, marks: group }) =>
    group.map(({ ref, ticket }) => ({ target, ref, ticket })),
  );
  const result = await tx.execute(sql`
    WITH dependents AS (${sql.join(selections, sql` UNION ALL `)}),
    written AS (
      INSERT INTO "DerivedDirty" (target, ref, priority)
      SELECT target, ref, min(priority) FROM dependents GROUP BY target, ref
      ORDER BY target, ref
      ON CONFLICT (target, ref) DO UPDATE SET
        ticket = nextval('"DerivedTicket"'),
        priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
        "readyAt" = now()
      RETURNING target, ref::text AS ref
    ), cleared AS (
      DELETE FROM "DerivedDirty" d
      USING (
        SELECT held.target, held.ref, held.ticket FROM "DerivedDirty" held
        JOIN jsonb_to_recordset(${JSON.stringify(observed)}::jsonb)
          AS m(target text, ref uuid, ticket bigint)
          ON held.target = m.target AND held.ref = m.ref AND held.ticket = m.ticket
        -- Finish dependent writes before clearing sources. An active writer
        -- may own a source mark while waiting on a dependent we just wrote;
        -- skip that mark rather than closing a deadlock cycle.
        WHERE (SELECT count(*) FROM written) >= 0
        FOR UPDATE OF held SKIP LOCKED
      ) held
      WHERE d.target = held.target AND d.ref = held.ref AND d.ticket = held.ticket
    ) SELECT target, ref FROM written`);
  // Several inputs can reach the same dependent. Grouping above both keeps the
  // highest priority and avoids updating one conflict row twice in a statement.
  return z
    .array(z.object({ target: z.string(), ref: z.string() }))
    .parse(result.rows);
};

/** SQLSTATE data exception, integrity violation or program limit: the target's own data. */
const isTargetDataError = (error: unknown) =>
  /^(22|23|54)/.test(findPgError(error)?.code ?? "");

/** The innermost cause carries the database's own message. */
const errorChainMessage = (error: Error): string => {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current instanceof Error && messages.length < 8;
    current = current.cause
  )
    messages.push(current.message.slice(0, 300));
  return messages.reverse().join(" <- ");
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
      -- The exponent is clamped first: an unbounded power overflows bigint
      -- after ~50 failures and would roll back every page holding the mark.
      "readyAt" = now() + least(${FAILURE_MAX_MS}::bigint,
        ${FAILURE_BASE_MS}::bigint * (2 ^ least(d.attempts, 10))::bigint) * interval '1 millisecond'
      FROM jsonb_to_recordset(${JSON.stringify(
        marks.map(({ ref, ticket }) => ({ ref, ticket })),
      )}::jsonb) AS m(ref uuid, ticket bigint)
     WHERE d.target = ${target} AND d.ref = m.ref AND d.ticket = m.ticket`);
};

/** Publish one prepared page in the caller's transaction. */
export async function publishDerivedPage(
  db: Database,
  plan: DerivedPagePlan,
): Promise<DerivedPublication> {
  const tx = unwrapDb(db);
  let changed = 0;
  let expanded = 0;
  const affected = new Map<string, Set<string>>();
  const touch = (entity: string, ids: readonly string[]) => {
    const set = affected.get(entity) ?? new Set<string>();
    for (const id of ids) set.add(id);
    affected.set(entity, set);
  };
  const drift: { target: string; count: number }[] = [];
  const fanouts = await expandFanouts(tx, plan.marks);
  expanded += fanouts.length;
  for (const { target, ref } of fanouts) {
    const parsed = parseTarget(target);
    if (parsed) touch(parsed.declaration.entity, [ref]);
  }
  const groups = groupByTarget(plan.marks);
  const valueGroups = [...groups].flatMap(([target, marks]) => {
    const parsed = parseTarget(target);
    return parsed &&
      !parsed.fanoutInput &&
      !plan.failed.has(target) &&
      !plan.sinks.has(target)
      ? [
          {
            declaration: parsed.declaration,
            fanoutTickets: plan.fanoutTickets,
            marks,
            values: plan.computed.get(target) ?? new Map(),
          },
        ]
      : [];
  });
  let valueChanges: ReadonlyMap<string, readonly string[]> = new Map();
  const rejectedValues = new Set<string>();
  if (valueGroups.length > 0) {
    try {
      valueChanges = await withTransactionDatabase(db, (scoped) =>
        publishValues(unwrapDb(scoped), valueGroups),
      );
    } catch (error) {
      if (!isTargetDataError(error)) throw error;
      // A rejected batch leaves every ticket and value intact. Retry its targets
      // separately so one bad value cannot strand unrelated work.
      const recovered = new Map<string, readonly string[]>();
      for (const group of valueGroups) {
        try {
          const result = await withTransactionDatabase(db, (scoped) =>
            publishValues(unwrapDb(scoped), [group]),
          );
          recovered.set(
            group.declaration.target,
            result.get(group.declaration.target) ?? [],
          );
        } catch (targetError) {
          if (!isTargetDataError(targetError)) throw targetError;
          rejectedValues.add(group.declaration.target);
          await deferFailed(
            tx,
            group.declaration.target,
            group.marks,
            targetError instanceof Error
              ? errorChainMessage(targetError)
              : String(targetError),
          );
        }
      }
      valueChanges = recovered;
    }
  }
  for (const [target, marks] of groups) {
    const parsed = parseTarget(target);
    if (!parsed) {
      // A retired declaration's marks have nothing left to compute.
      await clearMarks(tx, target, marks);
      continue;
    }
    const { declaration, fanoutInput } = parsed;
    if (fanoutInput) continue;
    const failure = plan.failed.get(target);
    if (failure !== undefined) {
      await deferFailed(tx, target, marks, failure);
      continue;
    }
    if (rejectedValues.has(target)) continue;
    const sink = plan.sinks.get(target);
    // A write the database rejects for one target's data (a value too long
    // for its index, a constraint) rolls back alone and backs off; the rest
    // of the page publishes. Transaction-level failures still fail the page.
    // Inside the Job's transaction this is a savepoint.
    let changedIds: readonly string[];
    try {
      changedIds = sink
        ? await withTransactionDatabase(db, (scoped) =>
            publishSink(scoped, declaration, marks, sink, plan.fanoutTickets),
          )
        : (valueChanges.get(target) ?? []);
    } catch (error) {
      if (!isTargetDataError(error)) throw error;
      await deferFailed(
        tx,
        target,
        marks,
        error instanceof Error ? errorChainMessage(error) : String(error),
      );
      continue;
    }
    changed += changedIds.length;
    const reconciled = new Set(
      marks.filter((mark) => mark.priority === 2).map((mark) => mark.ref),
    );
    const drifted = changedIds.filter((id) => reconciled.has(id)).length;
    if (drifted > 0) drift.push({ target, count: drifted });
    // Every claimed record's freshness changed, whether or not its value did.
    touch(
      declaration.entity,
      marks.map((mark) => mark.ref),
    );
    await propagate(tx, declaration, changedIds);
  }
  const ids = [...affected.values()].flatMap((set) => [...set]);
  const codes = new Map(
    ids.length === 0
      ? []
      : z
          .array(z.object({ id: z.string(), shortcode: z.string() }))
          .parse(
            (
              await tx.execute(sql`
                SELECT id::text AS id, shortcode FROM "Entity"
                 WHERE id = ANY(${uuidArrayParam(ids)}) AND shortcode IS NOT NULL`)
            ).rows,
          )
          .map((row) => [row.id, row.shortcode]),
  );
  return {
    processed: plan.marks.length,
    changed,
    expanded,
    categories: [...affected.keys()].sort(),
    changes: Object.fromEntries(
      [...affected].map(([entity, set]) => [
        entity,
        set.size > RING_RECORD_LIMIT
          ? null
          : [...set].flatMap((id) => {
              const code = codes.get(id);
              return code ? [code] : [];
            }),
      ]),
    ),
    drift,
  };
}

/** Mark every stored value at reconcile priority; publication reports drift. */
export async function markAllStoredDerived(
  db: Database | DrizzleTransaction,
  include: (declaration: StoredDerivedDeclaration) => boolean = () => true,
  /** Only records whose id hashes to `index` of `count` buckets. */
  slice?: { readonly index: number; readonly count: number },
): Promise<number> {
  let marked = 0;
  for (const declaration of storedDerivedDeclarations().filter(include)) {
    const result = await unwrapDb(db).execute(sql`
      INSERT INTO "DerivedDirty" (target, ref, priority)
      SELECT ${declaration.target}, t.id, 2 FROM ${ident(declaration.table)} t
      ${slice ? sql`WHERE mod(abs(hashtext(t.id::text)), ${slice.count}) = ${slice.index}` : sql``}
      ON CONFLICT (target, ref) DO NOTHING
      RETURNING ref`);
    marked += result.rows.length;
  }
  return marked;
}

/** Calendar expiry reuses dirty marks and the existing minute drain, without resetting failures. */
export async function markExpiredClockDerived(
  db: Database | DrizzleTransaction,
): Promise<number> {
  const targets = storedDerivedDeclarations()
    .filter(
      (entry) =>
        entry.clock === "householdDay" && entry.publishes === "derivedValue",
    )
    .map(({ target, key, entity }) => ({ target, key, entity }));
  if (targets.length === 0) return 0;
  const result = await unwrapDb(db).execute(sql`
    WITH marked AS (
      INSERT INTO "DerivedDirty" (target, ref, priority)
      SELECT k.target, v."entityId", 2
        FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS k(target text, key text, entity text)
        JOIN "DerivedValue" v ON v.key = k.key
        JOIN ${entityIdentity} ON ${entityIdentity.id} = v."entityId" AND ${entityIdentity.kind} = k.entity AND ${notDeleted(entityIdentity)}
       WHERE ${householdDaySql(sql`v."computedAt"`)} < ${householdDaySql(sql`now() AT TIME ZONE 'UTC'`)}
      ON CONFLICT (target, ref) DO NOTHING
      RETURNING ref
    ), captured AS (
      INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      SELECT ${DERIVED_DRAIN_JOB_KEY}, now() AT TIME ZONE 'UTC' WHERE EXISTS (SELECT 1 FROM marked)
    )
    SELECT count(*)::integer AS count FROM marked`);
  return z.object({ count: z.number() }).parse(result.rows[0]).count;
}
