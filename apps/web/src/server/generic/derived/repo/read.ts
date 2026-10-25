import type { DerivedMeta } from "@cubby/schemas/derived-value";
/**
 * Reading stored derived values. Lists compile a stored field to one indexed
 * primary-key lookup, so sorting, filtering and the footer read the same
 * figure the row shows; freshness is one EXISTS on the dirty marks.
 */
import type { Entity } from "@cubby/schemas/entity";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  storedDerived,
  type StoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";

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
): SQL {
  const declaration = requireStored(entity, key);
  const column =
    declaration.sort === "date"
      ? sql.raw(`"sortDate"::date`)
      : declaration.sort === "text"
        ? sql.raw(`"sortText"`)
        : sql.raw(`"sortNumber"`);
  return sql`(SELECT ${column} FROM "DerivedValue" WHERE "entityId" = ${id} AND key = ${key})`;
}

/** The stored JSON value. */
export function storedDerivedValueSql(
  entity: Entity,
  key: string,
  id: AnyColumn | SQL,
): SQL {
  requireStored(entity, key);
  return sql`(SELECT value FROM "DerivedValue" WHERE "entityId" = ${id} AND key = ${key})`;
}

/** True while a recompute is queued for the record. */
export function storedDerivedStaleSql(
  entity: Entity,
  key: string,
  id: AnyColumn | SQL,
): SQL<boolean> {
  const declaration = requireStored(entity, key);
  return sql<boolean>`EXISTS (SELECT 1 FROM "DerivedDirty" WHERE target = ${declaration.target} AND ref = ${id})`;
}

const valueRow = z.object({
  entityId: z.string(),
  key: z.string(),
  value: z.unknown(),
  decidedBy: z.unknown(),
  computedAt: z.coerce.date().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
});

export interface StoredDerivedRead {
  readonly value: unknown;
  readonly meta: DerivedMeta;
}

/**
 * Stored values and their meta for a page of records, in one statement. A
 * record without a row reads as missing; a queued mark as stale; a mark with
 * a recorded error as failed (the previous value stays).
 */
export async function loadStoredDerived(
  db: Database | DrizzleTransaction,
  entity: Entity,
  ids: readonly string[],
  keys: readonly string[],
): Promise<Map<string, Map<string, StoredDerivedRead>>> {
  const declarations = keys.map((key) => requireStored(entity, key));
  const out = new Map<string, Map<string, StoredDerivedRead>>();
  if (ids.length === 0 || declarations.length === 0) return out;
  const result = await unwrapDb(db).execute(sql`
    SELECT i.id AS "entityId", k.key, v.value, v."decidedBy", v."computedAt",
           d.ref IS NOT NULL AS stale, d."lastError" AS error
      FROM unnest(${uuidArrayParam(ids)}) AS i(id)
     CROSS JOIN jsonb_to_recordset(${JSON.stringify(
       declarations.map(({ key, target }) => ({ key, target })),
     )}::jsonb) AS k(key text, target text)
      LEFT JOIN "DerivedValue" v ON v."entityId" = i.id AND v.key = k.key
      LEFT JOIN "DerivedDirty" d ON d.target = k.target AND d.ref = i.id`);
  for (const row of z.array(valueRow).parse(result.rows)) {
    const byKey = out.get(row.entityId) ?? new Map();
    const parsed = z
      .object({ level: z.string() })
      .passthrough()
      .nullable()
      .catch(null)
      .parse(row.decidedBy ?? null);
    byKey.set(row.key, {
      value: row.value ?? null,
      meta: {
        state:
          row.computedAt === null
            ? "missing"
            : row.error
              ? "failed"
              : row.stale
                ? "stale"
                : "fresh",
        // SAFETY: drain writes `decidedBy` only from adapters' typed DecidedBy.
        decidedBy: parsed as DerivedMeta["decidedBy"],
        asOf: row.computedAt?.toISOString() ?? null,
        error: row.error,
      },
    });
    out.set(row.entityId, byKey);
  }
  return out;
}
