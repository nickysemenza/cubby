import { dateTime } from "@cubby/schemas/codec";
import { storedFieldDecision } from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
/**
 * Reading stored derived values. Lists compile a stored field to one indexed
 * primary-key lookup, so sorting, filtering and the footer read the same
 * figure the row shows. Publication existence distinguishes missing output from
 * a successful empty value, including optional typed snapshot members.
 */
import {
  fieldDecision,
  fieldProvenance,
  fieldWorkAttribution,
} from "@cubby/schemas/field-envelope";
import { workWaitCause } from "@cubby/schemas/job";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type EntityStoredDerivedDeclaration,
  storedDerived,
} from "~/server/db/derived-declarations";
import { storedSourceSql } from "~/server/db/derived-source-sql";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import type {
  PageStoredMeta,
  StoredDerivedRead,
  CurrentReadFacts,
} from "~/server/generic/derived/repo/read-context";

export type {
  PageStoredMeta,
  StoredDerivedRead,
} from "~/server/generic/derived/repo/read-context";

const requireStored = (
  entity: Entity,
  key: string,
): EntityStoredDerivedDeclaration => {
  const declaration = storedDerived(entity, key);
  if (!declaration)
    throw new Error(`${entity}.model.derived.${key} is not stored`);
  return declaration;
};

const publishedOutcome = {
  value: storedFieldDecision.shape.outcome.options[0].shape.kind.value,
  empty: storedFieldDecision.shape.outcome.options[1].shape.kind.value,
} satisfies { value: "value"; empty: "empty" };

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
  const derived = Object.entries(
    generatedEntityListFields[entity].derived,
  ).find(([name]) => name === key)?.[1];
  const fromResult =
    derived && "fromResult" in derived ? derived.fromResult : undefined;
  const storedKey = field?.storedKey ?? fromResult?.key ?? key;
  const declaration = requireStored(entity, storedKey);
  const path =
    (field && "storedPath" in field ? field.storedPath : undefined) ??
    fromResult?.path;
  const kind =
    field?.kind ?? (derived && "type" in derived ? derived.type : undefined);
  const projected = path
    ? sql`value #>> ARRAY[${sql.join(
        path.map((part: string) => sql`${part}`),
        sql`, `,
      )}]::text[]`
    : null;
  const column = projected
    ? kind === "number"
      ? sql`(${projected})::double precision`
      : kind === "date" || kind === "timestamp"
        ? sql`(${projected})::timestamptz`
        : kind === "boolean"
          ? sql`(${projected})::boolean`
          : projected
    : declaration.sort === "date"
      ? sql.raw(`"sortDate"::date`)
      : declaration.sort === "text"
        ? sql.raw(`"sortText"`)
        : sql.raw(`"sortNumber"`);
  const cached = sql`(SELECT ${column} FROM (${storedSourceSql(declaration, sql`${id}`)}) projected
    WHERE "decidedBy"#>>'{outcome,kind}' = 'value'
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
  const derived = Object.entries(
    generatedEntityListFields[entity].derived,
  ).find(([name]) => name === key)?.[1];
  const fromResult =
    derived && "fromResult" in derived ? derived.fromResult : undefined;
  const path = fromResult?.path;
  const declaration = storedDerived(
    entity,
    field?.storedKey ?? fromResult?.key ?? key,
  );
  return declaration &&
    (declaration.publishes === "derivedValue" || declaration.snapshotSource)
    ? sql`EXISTS (SELECT 1 FROM (${storedSourceSql(declaration, sql`${id}`)}) v
      WHERE v."computedAt" IS NOT NULL AND v."decidedBy"#>>'{outcome,kind}' IN (${publishedOutcome.value}, ${publishedOutcome.empty})
      ${
        path
          ? sql`AND v.value #> ARRAY[${sql.join(
              path.map((part: string) => sql`${part}`),
              sql`, `,
            )}]::text[] IS NOT NULL`
          : sql``
      }
      ${currentValue ? sql`AND (${currentValue} IS NOT NULL OR v."decidedBy"#>>'{outcome,kind}' = ${publishedOutcome.empty})` : sql``})`
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

const decisionSchema = fieldDecision(z.unknown());
const valueRow = z.object({
  entityId: z.string(),
  key: z.string(),
  value: z.unknown(),
  decidedBy: z.unknown(),
  computedAt: dateTime.nullable(),
  stale: z.boolean(),
  pending: z.boolean(),
  waiting: z.boolean(),
  waitCause: workWaitCause.nullable(),
  runningSince: dateTime.nullable(),
  leaseExpiresAt: dateTime.nullable(),
  error: z.string().nullable(),
  retryAt: dateTime.nullable(),
  refreshReason: z.string().nullable(),
  attribution: fieldWorkAttribution.nullable(),
});

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
  // Snapshot freshness belongs to the coarse hourly pass, never retained tickets.
  const result = await unwrapDb(db).execute(
    sql`
    WITH keys AS (SELECT * FROM (VALUES ${sql.join(
      declarations.map(({ key }) => sql`(${key}::text)`),
      sql`, `,
    )}) AS declared(key))
    SELECT i.id AS "entityId", k.key, v.value,
           ${options.includeEvidence ? sql`v."decidedBy"` : sql`v."decidedBy" - ${storedFieldDecision.keyof().enum.evidence}`} AS "decidedBy", v."computedAt",
           false AS pending, false AS stale, NULL::text AS "refreshReason", NULL::text AS attribution,
           NULL::text AS error, NULL::timestamp AS "retryAt", false AS waiting, NULL::text AS "waitCause",
           NULL::timestamp AS "runningSince", NULL::timestamp AS "leaseExpiresAt"
      FROM unnest(${uuidArrayParam(ids)}) AS i(id)
     CROSS JOIN keys k
      LEFT JOIN LATERAL (
        ${sql.join(
          declarations.map(
            (declaration) => sql`
          SELECT projected.* FROM LATERAL (${storedSourceSql(declaration, sql`i.id`)}) projected
          WHERE k.key = ${declaration.key}`,
          ),
          sql` UNION ALL `,
        )}
      ) v ON true`,
    "objects",
  );
  for (const row of z.array(valueRow).parse(result)) {
    const byKey = out.get(row.entityId) ?? new Map();
    const metadata = storedFieldDecision.safeParse(row.decidedBy);
    const decision = decisionSchema.safeParse(
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
      refreshReason: row.refreshReason,
      ...(row.attribution ? { attribution: row.attribution } : {}),
      waiting: row.waiting,
      waitCause: row.waitCause,
      ...(row.runningSince && row.leaseExpiresAt
        ? {
            execution: {
              startedAt: row.runningSince.toISOString(),
              leaseExpiresAt: row.leaseExpiresAt.toISOString(),
            },
          }
        : {}),
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
  requested?: readonly string[],
): Promise<Map<string, CurrentReadFacts>> {
  const fields = entityFieldModels[entity].fields.filter((field) => {
    const key = field.readKey ?? field.key;
    return field.storedPath && (!requested || requested.includes(key));
  });
  const reads = await (started ??
    loadStoredDerived(db, entity, ids, [
      ...new Set(
        fields.flatMap((field) => (field.storedKey ? [field.storedKey] : [])),
      ),
    ]));
  for (const id of ids)
    for (const field of fields)
      if (field.storedKey && !reads.get(id)?.has(field.storedKey))
        throw new Error(
          `Stored projection was not loaded: ${entity}.${field.storedKey}`,
        );
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
