import { LEGACY_SHORTCODE_PREFIX, parseShortcode } from "@cubby/shared";
import { SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { textArrayParam, uuidArrayParam } from "~/server/db/helpers/query";

/**
 * The only way repository SQL binds a caller-supplied set of records.
 *
 * Parameters are O(1) per use, never O(records): a set is lowered to
 * `= ANY(array)` probes, so a statement that reads the same set in many UNION
 * arms stays small. Never lower a set to `or(...records.map(...))` or a
 * `VALUES` list; both bind every record again in every arm, which turned a
 * 50-row badge read into 1,083 parameters and a statement timeout.
 *
 * Probes stay `= ANY` rather than `IN (SELECT unnest(...))` or a CTE sublink:
 * with a bound parameter the planner cannot see into the subquery and falls
 * back to a hashed SubPlan over a full scan (measured on production: 270
 * buffers against 3).
 */
type RequestedRecord = {
  entity: string;
  id: string;
  code?: string;
};

/**
 * Where a record reference lives: a uuid column, or stored text naming a
 * record by UUID, shortcode or legacy-prefix alias in any case.
 */
type RecordRef =
  | { entity: string | SQL; id: SQL | SQL.Aliased }
  | { entity: string | SQL; token: SQL<string> | SQL<string | null> };

export interface Requested {
  readonly size: number;
  /** Requested entities, for pruning arms that cannot match. */
  readonly entities: ReadonlySet<string>;
  /** Distinct ids, optionally for one entity. */
  ids(entity?: string): readonly string[];
  /** Index-shaped semi-join predicate; `false` when no requested record can match. */
  match(ref: RecordRef): SQL;
  /** Upper-cased stored-reference keys of one record, for attributing token matches. */
  keysOf(record: { entity: string; id: string }): readonly string[];
}

const uuid = z.uuid();

/**
 * The keys a stored reference may name a record by, as `parseShortcode` and
 * the UUID lookup resolve them: its UUID, its code and any legacy-prefix alias
 * of that code (`P-4K7M` names `PRD-4K7M`), all upper-cased.
 */
function recordKeys(record: RequestedRecord, id: string) {
  const keys = [id.toUpperCase()];
  if (!record.code) return keys;
  const parsed = parseShortcode(record.code);
  const code = parsed?.shortcode ?? record.code.trim().toUpperCase();
  const dash = code.indexOf("-");
  const legacy = Object.entries(LEGACY_SHORTCODE_PREFIX).flatMap(
    ([prefix, entity]) =>
      entity === record.entity && dash > 0
        ? [`${prefix}${code.slice(dash + 1)}`]
        : [],
  );
  return [...keys, code, ...legacy];
}

/** Stored tokens compare after the same normalisation as `recordKeys`. */
const normalisedToken = (token: SQL) => sql`upper(btrim(${token}))`;

export function requested(records: readonly RequestedRecord[]): Requested {
  const byEntity = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    const id = uuid.parse(record.id).toLowerCase();
    const group = byEntity.get(record.entity) ?? new Map<string, Set<string>>();
    const keys = group.get(id) ?? new Set<string>();
    for (const key of recordKeys(record, id)) keys.add(key);
    group.set(id, keys);
    byEntity.set(record.entity, group);
  }
  const entities = [...byEntity.keys()];
  const ids = (entity?: string) =>
    entity === undefined
      ? [...byEntity.values()].flatMap((group) => [...group.keys()])
      : [...(byEntity.get(entity)?.keys() ?? [])];
  const keys = (entity: string) =>
    [...(byEntity.get(entity)?.values() ?? [])].flatMap((set) => [...set]);
  const qualified = (pick: (entity: string) => readonly string[]) =>
    entities.flatMap((entity) =>
      pick(entity).map((value) => `${entity}:${value}`),
    );

  return {
    size: ids().length,
    entities: new Set(entities),
    ids,
    keysOf: (record) => [
      ...(byEntity.get(record.entity)?.get(record.id.toLowerCase()) ?? []),
    ],
    match(ref) {
      if (typeof ref.entity === "string") {
        if ("token" in ref) {
          const selected = keys(ref.entity);
          return selected.length
            ? sql`${normalisedToken(ref.token)} = ANY(${textArrayParam(selected)})`
            : sql`false`;
        }
        const selected = ids(ref.entity);
        return selected.length
          ? sql`${ref.id} = ANY(${uuidArrayParam(selected)})`
          : sql`false`;
      }
      if (!entities.length) return sql`false`;
      const entity = ref.entity;
      // Both array probes drive the composite (entity, id) index; with several
      // entities the qualified recheck removes cross-entity combinations.
      if ("token" in ref) {
        const token = normalisedToken(ref.token);
        const all = entities.flatMap(keys);
        return entities.length === 1
          ? sql`(${entity} = ${entities[0]} AND ${token} = ANY(${textArrayParam(all)}))`
          : sql`(${entity} = ANY(${textArrayParam(entities)}) AND ${token} = ANY(${textArrayParam(
              all,
            )}) AND (${entity} || ':' || ${token}) = ANY(${textArrayParam(
              qualified(keys),
            )}))`;
      }
      return entities.length === 1
        ? sql`(${entity} = ${entities[0]} AND ${ref.id} = ANY(${uuidArrayParam(ids())}))`
        : sql`(${entity} = ANY(${textArrayParam(entities)}) AND ${ref.id} = ANY(${uuidArrayParam(
            ids(),
          )}) AND (${entity} || ':' || ${ref.id}::text) = ANY(${textArrayParam(
            qualified(ids),
          )}))`;
    },
  };
}

/** Positional `text[]` that keeps duplicates and NULLs, for `unnest` columns. */
const nullableTextArrayParam = (values: readonly (string | null)[]): SQL =>
  sql`${`{${values
    .map((value) => (value === null ? "NULL" : arrayElement(value)))
    .join(",")}}`}::text[]`;

type ColumnType =
  | "uuid"
  | "text"
  | "int"
  | "numeric"
  | "timestamp"
  | "timestamptz"
  | "bool";

type RequestedRows<C> = {
  from: SQL;
  col(name: keyof C & string): SQL;
};

/**
 * Tuples with extra columns as one relation, binding ONE array per column.
 * Use it instead of a `VALUES` list, which binds every value of every row.
 */
export function requestedRows<C extends Record<string, ColumnType>>(
  rows: readonly { [K in keyof C]: string | number | boolean | null }[],
  columns: C,
  alias: string,
): RequestedRows<C> {
  // SAFETY: `Object.keys` of `C` returns exactly its own string keys.
  const names = Object.keys(columns) as (keyof C & string)[];
  const cast = (name: keyof C & string) => sql.raw(columns[name] ?? "text");
  const arrays = names.map((name) => {
    const values = rows.map((row) => {
      const value = row[name];
      return value === null ? null : String(value);
    });
    return sql`${nullableTextArrayParam(values)}::${cast(name)}[]`;
  });
  const table = sql.identifier(alias);
  return {
    from: rows.length
      ? sql`unnest(${sql.join(arrays, sql`, `)}) AS ${table}(${sql.join(
          names.map((name) => sql.identifier(name)),
          sql`, `,
        )})`
      : sql`(SELECT ${sql.join(
          names.map(
            (name) => sql`NULL::${cast(name)} AS ${sql.identifier(name)}`,
          ),
          sql`, `,
        )} WHERE false) AS ${table}`,
    col: (name) => sql`${table}.${sql.identifier(name)}`,
  };
}
