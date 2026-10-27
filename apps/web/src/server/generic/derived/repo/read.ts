import { storedFieldDecision } from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
/**
 * Reading stored derived values. Lists compile a stored field to one indexed
 * primary-key lookup, so sorting, filtering and the footer read the same
 * figure the row shows; freshness is one EXISTS on the dirty marks.
 */
import { fieldDecision, fieldProvenance } from "@cubby/schemas/field-envelope";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import {
  storedDerived,
  storedDerivedDeclarations,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import type {
  PageStoredMeta,
  StoredDerivedRead,
} from "~/server/generic/derived/repo/read-context";
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

/** The typed sort projection of a stored value, for ORDER BY, WHERE and SUM. */
export function storedDerivedSql(
  entity: Entity,
  key: string,
  id: AnyColumn | SQL,
  { currentAssignment }: { currentAssignment?: SQL } = {},
): SQL {
  const declaration = requireStored(entity, key);
  const column =
    declaration.sort === "date"
      ? sql.raw(`"sortDate"::date`)
      : declaration.sort === "text"
        ? sql.raw(`"sortText"`)
        : sql.raw(`"sortNumber"`);
  const cached = sql`(SELECT ${column} FROM "DerivedValue" WHERE "entityId" = ${id} AND key = ${key}
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

const valueRow = z.object({
  entityId: z.string(),
  key: z.string(),
  value: z.unknown(),
  decidedBy: z.unknown(),
  computedAt: z.coerce.date().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  retryAt: z.coerce.date().nullable(),
});

/** Page readers start this with their ids beside hydration, never once per row. */
export function loadPageStoredMeta(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
): Promise<PageStoredMeta> {
  const keys = storedDerivedDeclarations()
    .filter(
      (declaration) =>
        declaration.entity === entity &&
        declaration.publishes === "derivedValue",
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
): Promise<Map<string, Map<string, StoredDerivedRead>>> {
  const declarations = keys.map((key) => requireStored(entity, key));
  const out = new Map<string, Map<string, StoredDerivedRead>>();
  if (ids.length === 0 || declarations.length === 0) return out;
  const result = await unwrapDb(db).execute(sql`
    SELECT i.id AS "entityId", k.key, v.value, v."decidedBy", v."computedAt",
           d.ref IS NOT NULL AS stale, d."lastError" AS error, d."readyAt" AS "retryAt"
      FROM unnest(${uuidArrayParam(ids)}) AS i(id)
     CROSS JOIN jsonb_to_recordset(${JSON.stringify(
       declarations.map(({ key, target }) => ({ key, target })),
     )}::jsonb) AS k(key text, target text)
      LEFT JOIN "DerivedValue" v ON v."entityId" = i.id AND v.key = k.key
      LEFT JOIN "DerivedDirty" d ON d.target = k.target AND d.ref = i.id`);
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
      ...(decision.success ? { decision: decision.data } : {}),
      resultExists: row.computedAt !== null && decision.success,
      stale: row.stale,
      retryAt: row.retryAt?.toISOString() ?? null,
      computedAt: row.computedAt?.toISOString() ?? null,
      error: row.error,
    });
    out.set(row.entityId, byKey);
  }
  return out;
}
