import { dateTime } from "@cubby/schemas/codec";
import { storedFieldDecision } from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
/**
 * Reading stored derived values. Lists compile a stored field to one indexed
 * primary-key lookup, so sorting, filtering and the footer read the same
 * figure the row shows; freshness is one EXISTS on the dirty marks.
 */
import { fieldDecision, fieldProvenance } from "@cubby/schemas/field-envelope";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import {
  storedDerived,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { householdDaySql, uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import type {
  PageStoredMeta,
  StoredDerivedRead,
  CurrentReadFacts,
} from "~/server/generic/derived/repo/read-context";
import {
  owedWorkItem,
  workPendingWhere,
} from "~/server/generic/jobs/repo/work-items";

import { fanoutTargetMatches } from "./fanout";
export type {
  PageStoredMeta,
  StoredDerivedRead,
} from "~/server/generic/derived/repo/read-context";

const requireStored = (
  entity: Entity,
  key: string,
): StoredDerivedDeclaration => {
  const declaration = storedDerived(entity, key);
  if (!declaration)
    throw new Error(`${entity}.model.derived.${key} is not stored`);
  return declaration;
};

const publishedOutcome = {
  value: storedFieldDecision.shape.outcome.options[0].shape.kind.value,
  empty: storedFieldDecision.shape.outcome.options[1].shape.kind.value,
} satisfies { value: "value"; empty: "empty" };

/** Keep publication identity and the kind/key index predicate together. */
export function storedPublicationMatch(
  publication: {
    entityId: AnyColumn | SQL;
    kind: AnyColumn | SQL;
    key: AnyColumn | SQL;
  },
  {
    entity,
    id,
    key,
  }: { entity: Entity; id: AnyColumn | SQL; key: string | SQL },
): SQL {
  return sql`(${publication.entityId} = ${id} AND ${publication.kind} = ${entity} AND ${publication.key} = ${key})`;
}

/** The typed sort projection of a stored value, for ORDER BY, WHERE and SUM. */
export function storedDerivedSql(
  entity: Entity,
  key: string,
  id: AnyColumn | SQL,
  { currentAssignment }: { currentAssignment?: SQL } = {},
): SQL {
  const field = entityFieldModels[entity].fields.find(
    (field) => field.key === key,
  );
  const storedKey = field?.storedKey ?? key;
  const declaration = requireStored(entity, storedKey);
  const path = field && "storedPath" in field ? field.storedPath : undefined;
  const projected = path
    ? sql`value #>> ARRAY[${sql.join(
        path.map((part) => sql`${part}`),
        sql`, `,
      )}]::text[]`
    : null;
  const column =
    projected && field
      ? field.kind === "number"
        ? sql`(${projected})::double precision`
        : field.kind === "date" || field.kind === "timestamp"
          ? sql`(${projected})::timestamptz`
          : field.kind === "boolean"
            ? sql`(${projected})::boolean`
            : projected
      : declaration.sort === "date"
        ? sql.raw(`"sortDate"::date`)
        : declaration.sort === "text"
          ? sql.raw(`"sortText"`)
          : sql.raw(`"sortNumber"`);
  const cached = sql`(SELECT ${column} FROM "DerivedValue" WHERE ${storedPublicationMatch(
    { entityId: sql`"entityId"`, kind: sql`kind`, key: sql`key` },
    { entity, id, key: storedKey },
  )}
    AND "decidedBy"#>>'{outcome,kind}' = 'value'
    ${
      currentAssignment
        ? sql`AND ("decidedBy"#>>'{provenance,kind}') IS NOT NULL
      AND ("decidedBy"#>>'{provenance,kind}') <> ${fieldProvenance.options[0].shape.kind.value}`
        : sql``
    })`;
  return currentAssignment
    ? sql`COALESCE(${currentAssignment}, ${cached})`
    : cached;
}

/** Successful empty values are known; an absent publication cannot satisfy a negative filter. */
export function storedFieldAvailableSql(
  entity: Entity,
  key: string,
  id: AnyColumn | SQL,
  { currentValue }: { currentValue?: SQL } = {},
): SQL | null {
  const field = entityFieldModels[entity].fields.find(
    (field) => field.key === key,
  );
  const declaration = storedDerived(entity, field?.storedKey ?? key);
  return declaration?.publishes === "derivedValue"
    ? sql`EXISTS (
    SELECT 1 FROM "DerivedValue" v WHERE ${storedPublicationMatch(
      { entityId: sql`v."entityId"`, kind: sql`v.kind`, key: sql`v.key` },
      { entity, id, key: declaration.key },
    )}
      AND v."computedAt" IS NOT NULL AND v."decidedBy"#>>'{outcome,kind}' IN (${publishedOutcome.value}, ${publishedOutcome.empty})
      ${currentValue ? sql`AND (${currentValue} IS NOT NULL OR v."decidedBy"#>>'{outcome,kind}' = ${publishedOutcome.empty})` : sql``}
  )`
    : null;
}

/** A projection keeps the exact result revision, provenance and work of its owner. */
export function projectStoredResult(
  read: StoredDerivedRead,
  path: readonly string[],
): StoredDerivedRead {
  let value = read.value;
  for (const segment of path) {
    const object = z.record(z.string(), z.unknown()).safeParse(value);
    if (!object.success || !Object.hasOwn(object.data, segment))
      return { ...read, value: null, decision: undefined, resultExists: false };
    value = object.data[segment];
  }
  return {
    ...read,
    value,
    ...(read.decision
      ? {
          decision: {
            provenance: read.decision.provenance,
            outcome:
              value == null
                ? { kind: "empty", reason: "unset" }
                : { kind: "value", value },
          },
        }
      : {}),
  };
}

/** A scoped fold must name the exact publication it read; races remain unavailable. */
export function projectStoredValue(
  read: StoredDerivedRead,
  value: StoredDerivedRead["value"],
  revision: string | null | undefined,
): StoredDerivedRead {
  if (!read.resultExists || !read.computedAt || revision !== read.computedAt)
    return { ...read, value: null, decision: undefined, resultExists: false };
  return {
    ...read,
    value,
    decision: read.decision
      ? {
          provenance: read.decision.provenance,
          outcome:
            value == null
              ? { kind: "empty", reason: "unset" }
              : { kind: "value", value },
        }
      : undefined,
  };
}

const valueRow = z.object({
  entityId: z.string(),
  key: z.string(),
  value: z.unknown(),
  decidedBy: z.unknown(),
  computedAt: dateTime.nullable(),
  stale: z.boolean(),
  pending: z.boolean(),
  error: z.string().nullable(),
  retryAt: dateTime.nullable(),
});

/** Page readers start this with their ids beside hydration, never once per row. */
export function loadPageStoredMeta(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
): Promise<PageStoredMeta> {
  // Internal publications can contain unfenced findings; only model consumers
  // admit their values into public read contexts. Domain readers name other keys explicitly.
  const exposed = new Set<string>(
    entityFieldModels[entity].fields.flatMap((field) => [
      field.key,
      ...(field.readKey ? [field.readKey] : []),
      ...(field.storedKey ? [field.storedKey] : []),
    ]),
  );
  const keys = storedDerivedDeclarations()
    .filter(
      (declaration) =>
        declaration.entity === entity &&
        exposed.has(declaration.key) &&
        (declaration.publishes === "derivedValue" ||
          declaration.recordSource !== null),
    )
    .map((declaration) => declaration.key);
  return loadStoredDerived(db, entity, ids, keys);
}

/**
 * Stored values and their meta for a page of records, in one statement. A
 * record without a row reads as missing; a queued mark as stale; a mark with
 * a recorded error as failed (the previous value stays).
 */
export async function loadStoredDerived(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
  keys: readonly string[],
  options: { includeEvidence?: boolean } = {},
): Promise<Map<string, Map<string, StoredDerivedRead>>> {
  const declarations = keys.map((key) => requireStored(entity, key));
  const out = new Map<string, Map<string, StoredDerivedRead>>();
  if (ids.length === 0 || declarations.length === 0) return out;
  const result = await unwrapDb(db).execute(sql`
    WITH keys AS MATERIALIZED (
      SELECT declared.*, ${workPendingWhere((column) =>
        fanoutTargetMatches(column, sql`declared.target`),
      )} AS "fanoutPending"
      FROM jsonb_to_recordset(${JSON.stringify(
        declarations.map(({ key, target, clock }) => ({ key, target, clock })),
      )}::jsonb) AS declared(key text, target text, clock text)
    )
    SELECT i.id AS "entityId", k.key, v.value,
           ${options.includeEvidence ? sql`v."decidedBy"` : sql`v."decidedBy" - ${storedFieldDecision.keyof().enum.evidence}`} AS "decidedBy", v."computedAt",
           (d.ref IS NOT NULL OR k."fanoutPending") AS pending,
           (d.ref IS NOT NULL OR k."fanoutPending" OR (k.clock = 'householdDay' AND
             ${householdDaySql(sql`v."computedAt"`)} < ${householdLocalDate(new Date())}::date)) IS TRUE AS stale,
           d."lastError" AS error, d."readyAt" AS "retryAt"
      FROM unnest(${uuidArrayParam(ids)}) AS i(id)
     CROSS JOIN keys k
      LEFT JOIN "DerivedValue" v ON ${storedPublicationMatch(
        { entityId: sql`v."entityId"`, kind: sql`v.kind`, key: sql`v.key` },
        { entity, id: sql`i.id`, key: sql`k.key` },
      )}
      LEFT JOIN LATERAL ${owedWorkItem(sql`k.target`, sql`i.id`)} d ON true`);
  for (const row of z.array(valueRow).parse(result.rows)) {
    const byKey = out.get(row.entityId) ?? new Map();
    const metadata = storedFieldDecision.safeParse(row.decidedBy);
    const decision = fieldDecision(z.unknown()).safeParse(
      metadata.success
        ? {
            provenance: metadata.data.provenance,
            outcome:
              metadata.data.outcome.kind === "value"
                ? { kind: "value", value: row.value }
                : metadata.data.outcome,
          }
        : null,
    );
    byKey.set(row.key, {
      value: row.value ?? null,
      ...(metadata.success && metadata.data.evidence !== undefined
        ? { evidence: metadata.data.evidence }
        : {}),
      ...(decision.success ? { decision: decision.data } : {}),
      resultExists: row.computedAt !== null && decision.success,
      stale: row.stale,
      pending: row.pending,
      retryAt: row.retryAt?.toISOString() ?? null,
      computedAt: row.computedAt?.toISOString() ?? null,
      error: row.error,
    });
    out.set(row.entityId, byKey);
  }
  return out;
}

/** Raw repository hydration of declared projections; public envelopes retain availability. */
export async function loadStoredFieldProjections(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
  started?: Promise<PageStoredMeta>,
): Promise<Map<string, CurrentReadFacts>> {
  const fields = entityFieldModels[entity].fields.filter(
    (field) => field.storedPath,
  );
  const reads = await (started ??
    loadStoredDerived(db, entity, ids, [
      ...new Set(
        fields.flatMap((field) => (field.storedKey ? [field.storedKey] : [])),
      ),
    ]));
  return new Map(
    ids.map((id) => [
      id,
      Object.fromEntries(
        fields.map((field) => {
          const read = field.storedKey
            ? reads.get(id)?.get(field.storedKey)
            : undefined;
          const selected =
            read && field.storedPath
              ? projectStoredResult(read, field.storedPath)
              : undefined;
          return [
            field.readKey ?? field.key,
            selected?.resultExists ? selected.value : null,
          ];
        }),
      ),
    ]),
  );
}
