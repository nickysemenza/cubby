/**
 * The only implementation of inherited values: a field that declares
 * `resolution.inherit` reads its effective value, its fallback, and the
 * record that decided it from here, so a read, its `fieldResolutions`
 * provenance, and a filter, sort or group cannot disagree. Repositories
 * format provenance labels; the rule lives in the declaration.
 *
 * Each expression is a scalar correlated subquery, so a caller can use it in
 * any query without changing its row cardinality. It carries no bind
 * parameters: every literal comes from the generated declaration and is
 * inlined, so a SELECT and its GROUP BY render identical text (drizzle's
 * relational `extras` drop `.inlineParams()` flags). Generated aliases start
 * with `ih` plus their nesting depth, so nested chains never shadow the row
 * they read.
 */
import type { Entity } from "@cubby/schemas/entity";
import {
  type GeneratedInherit,
  generatedEntityListFields,
} from "@cubby/schemas/entity-list-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { type SQL, sql } from "drizzle-orm";

/** The row an effective value reads: a table alias in scope, or its id. */
export type InheritedRow = string | { readonly id: SQL };

type Source = GeneratedInherit["from"][number];
type Hop = Extract<Source, { kind: "effective" }>["hops"][number];

const chainOf = (entity: Entity, field: string): GeneratedInherit | null =>
  Object.entries(generatedEntityListFields[entity].inherit).find(
    ([key]) => key === field,
  )?.[1] ?? null;

const requireChain = (entity: Entity, field: string): GeneratedInherit => {
  const chain = chainOf(entity, field);
  if (chain === null)
    throw new Error(`${entity}.${field} declares no resolution.inherit`);
  return chain;
};

/** The field `column` stores, when it declares `resolution.inherit`. */
export const inheritedFieldOfColumn = (
  entity: Entity,
  column: string,
): string | null =>
  Object.entries(generatedEntityListFields[entity].inherit).find(
    ([, chain]) => chain.column === column,
  )?.[0] ?? null;

const tableOf = (entity: Entity) => {
  const { dbTable, softDelete } = entityManifest[entity];
  if (dbTable === null)
    throw new Error(`${entity} has no table to inherit from`);
  return { dbTable, table: sql.raw(`"${dbTable}"`), softDelete };
};

const unquoted = (alias: string) => alias.replace(/^"(.*)"$/, "$1");
const ref = (alias: string, column: string) =>
  sql.raw(`"${unquoted(alias)}"."${column}"`);
const name = (alias: string) => sql.raw(`"${alias}"`);
// Declared mode values are plain words, checked by the generator.
const literal = (value: string) => sql.raw(`'${value}'`);
const live = (alias: string, softDelete: boolean) =>
  softDelete ? sql` AND ${ref(alias, "deletedAt")} IS NULL` : sql``;

/** Whether the row's own stored value decides, over a row alias. */
const ownDecides = (chain: GeneratedInherit, alias: string): SQL => {
  const value = ref(alias, chain.column);
  if (chain.mode === null) return sql`${value} IS NOT NULL`;
  const decided = sql`${ref(alias, chain.mode.column)} <> ${literal(chain.mode.inherit)}`;
  return chain.mode.explicitIfSet
    ? sql`(${decided} OR ${value} IS NOT NULL)`
    : decided;
};

/** The row's own decision: its stored value, or NULL for a `none` mode. */
const ownValue = (chain: GeneratedInherit, alias: string): SQL => {
  const value = ref(alias, chain.column);
  if (chain.mode === null || chain.mode.none.length === 0) return value;
  return sql`CASE WHEN ${ref(alias, chain.mode.column)} IN (${sql.join(
    chain.mode.none.map(literal),
    sql`, `,
  )}) THEN NULL ELSE ${value} END`;
};

/**
 * The live records a path of to-one references leads to, starting at
 * `alias`: `tables` for a FROM list and `where` joining the first to the
 * row. A reference that is itself inherited is read effective.
 */
const pathFrom = (
  entity: Entity,
  hops: readonly Hop[],
  alias: string,
  depth: number,
  prefix: string,
): { tables: SQL; where: SQL; leaf: string; target: Entity } => {
  let current = entity;
  let currentAlias = alias;
  const tables: SQL[] = [];
  let where: SQL | undefined;
  for (const [index, hop] of hops.entries()) {
    const { table, softDelete } = tableOf(hop.target);
    const next = `ih${depth}${prefix}${index}`;
    const reference =
      chainOf(current, hop.field) === null
        ? ref(currentAlias, hop.column)
        : effectiveSql(current, hop.field, currentAlias, depth + 1);
    const condition = sql`${ref(next, "id")} = ${reference}${live(next, softDelete)}`;
    if (where === undefined) {
      tables.push(sql`${table} ${name(next)}`);
      where = condition;
    } else tables.push(sql`JOIN ${table} ${name(next)} ON ${condition}`);
    current = hop.target;
    currentAlias = next;
  }
  if (where === undefined)
    throw new Error(`${entity} inherits through no path`);
  return {
    tables: sql.join(tables, sql` `),
    where,
    leaf: currentAlias,
    target: current,
  };
};

/**
 * A field's decision at a record as `(v, src)` rows, one exactly when
 * something decides: its own value (`src` the record itself) or its first
 * deciding source (`src` the record that decided). A field without a chain
 * decides when it is not NULL.
 */
const decisionSql = (
  entity: Entity,
  { field, column }: Readonly<{ field: string; column: string }>,
  alias: string,
  depth: number,
): SQL => {
  const chain = chainOf(entity, field);
  if (chain === null) {
    const value = ref(alias, column);
    return sql`SELECT ${value} AS v, ${ref(alias, "id")} AS src WHERE ${value} IS NOT NULL`;
  }
  const decided = name(`ih${depth}d`);
  return sql`SELECT ${decided}.v, ${decided}.src FROM (SELECT 0 AS prio, ${ownValue(chain, alias)} AS v, ${ref(alias, "id")} AS src WHERE ${ownDecides(chain, alias)}${sql.join(
    chain.from.map(
      (source, index) =>
        sql` UNION ALL ${sourceSql(entity, chain, source, index + 1, alias, depth)}`,
    ),
    sql``,
  )}) ${decided} ORDER BY ${decided}.prio LIMIT 1`;
};

/** One source's decision as a `(prio, v, src)` row, present when it decides. */
const sourceSql = (
  entity: Entity,
  chain: GeneratedInherit,
  source: Source,
  prio: number,
  alias: string,
  depth: number,
): SQL => {
  const rank = sql.raw(String(prio));
  switch (source.kind) {
    case "hierarchy": {
      const { table, softDelete } = tableOf(entity);
      const walk = `ih${depth}w${prio}`;
      const node = `ih${depth}h${prio}`;
      const found = name(`ih${depth}a${prio}`);
      const columns = [
        "id",
        source.parentColumn,
        chain.column,
        ...(chain.mode === null ? [] : [chain.mode.column]),
      ].filter((column, index, all) => all.indexOf(column) === index);
      const select = (from: string) =>
        sql.join(
          columns.map((column) => ref(from, column)),
          sql`, `,
        );
      return sql`SELECT ${rank} AS prio, ${found}.v, ${found}.src FROM (
        WITH RECURSIVE ${name(walk)} AS (
          SELECT ${select(node)}, 1 AS ih_depth, array_remove(ARRAY[${ref(alias, "id")}, ${ref(node, "id")}], NULL) AS ih_visited
          FROM ${table} ${name(node)}
          WHERE ${ref(node, "id")} = ${ref(alias, source.parentColumn)}${live(node, softDelete)}
          UNION ALL
          SELECT ${select(node)}, ${ref(walk, "ih_depth")} + 1, ${ref(walk, "ih_visited")} || ${ref(node, "id")}
          FROM ${table} ${name(node)} JOIN ${name(walk)} ON ${ref(node, "id")} = ${ref(walk, source.parentColumn)}
          WHERE ${ref(walk, "ih_depth")} < ${sql.raw(String(source.maxDepth))}
            AND NOT ${ref(node, "id")} = ANY(${ref(walk, "ih_visited")})${live(node, softDelete)}
        )
        SELECT ${ownValue(chain, walk)} AS v, ${ref(walk, "id")} AS src FROM ${name(walk)}
        WHERE ${ownDecides(chain, walk)} ORDER BY ${ref(walk, "ih_depth")} LIMIT 1
      ) ${found}`;
    }
    case "effective": {
      const path = pathFrom(entity, source.hops, alias, depth, `s${prio}p`);
      const decided = name(`ih${depth}e${prio}`);
      return sql`SELECT ${rank} AS prio, ${decided}.v, ${decided}.src FROM ${path.tables} CROSS JOIN LATERAL (${decisionSql(path.target, source, path.leaf, depth + 1)}) ${decided} WHERE ${path.where}`;
    }
  }
};

/** The first deciding source's row `(prio, v, src)`, as a subquery body. */
const fallbackRowSql = (
  entity: Entity,
  chain: GeneratedInherit,
  alias: string,
  depth: number,
): { from: SQL; row: SQL } => {
  const row = name(`ih${depth}u`);
  return {
    row,
    from: sql`(${sql.join(
      chain.from.map((source, index) =>
        sourceSql(entity, chain, source, index + 1, alias, depth),
      ),
      sql` UNION ALL `,
    )}) ${row} ORDER BY ${row}.prio LIMIT 1`,
  };
};

const inheritedSql = (
  entity: Entity,
  chain: GeneratedInherit,
  alias: string,
  depth: number,
): SQL => {
  const { from, row } = fallbackRowSql(entity, chain, alias, depth);
  return sql`(SELECT ${row}.v FROM ${from})`;
};

/** The effective value over a row alias, starting nested aliases at `depth`. */
const effectiveSql = (
  entity: Entity,
  field: string,
  alias: string,
  depth: number,
): SQL => {
  const chain = requireChain(entity, field);
  const value = sql`CASE WHEN ${ownDecides(chain, alias)} THEN ${ownValue(chain, alias)} ELSE ${inheritedSql(entity, chain, alias, depth)} END`;
  return chain.empty === "array" ? sql`COALESCE(${value}, '{}')` : value;
};

const atRow = (
  entity: Entity,
  row: InheritedRow | undefined,
  render: (alias: string, depth: number) => SQL,
): SQL => {
  if (row === undefined || typeof row === "string")
    return render(row ?? tableOf(entity).dbTable, 1);
  const { table, softDelete } = tableOf(entity);
  const alias = "ih0r";
  return sql`(SELECT ${render(alias, 1)} FROM ${table} ${name(alias)} WHERE ${ref(alias, "id")} = ${row.id}${live(alias, softDelete)})`;
};

/**
 * A field's effective value at a row: its own decision, else the first
 * source in its declared chain that decides. `row` is an alias in scope
 * (default: the entity's table name) or a row id; a missing or deleted row
 * by id reads NULL. A non-nullable list reads `{}` when nothing decides.
 */
export const effectiveFieldSql = <T = unknown>(
  entity: Entity,
  field: string,
  row?: InheritedRow,
): SQL<T> =>
  atRow(entity, row, (alias, depth) =>
    effectiveSql(entity, field, alias, depth),
  ) as SQL<T>;

/**
 * The value a row would inherit if it did not decide itself: the first
 * declared source that decides, or NULL. Provenance reads it as the
 * fallback value.
 */
export const inheritedFieldSql = <T = unknown>(
  entity: Entity,
  field: string,
  row?: InheritedRow,
): SQL<T> =>
  atRow(entity, row, (alias, depth) =>
    inheritedSql(entity, requireChain(entity, field), alias, depth),
  ) as SQL<T>;

/**
 * Which declared source supplies the fallback and the record that decided
 * it: `{ source, id }` with `source` the 1-based index into
 * `resolution.inherit.from` (a hierarchy source's record is the deciding
 * ancestor; a path source's is the record its chain decided at), or NULL
 * when no source decides. Provenance reads it as the source entity.
 */
export const inheritedSourceSql = (
  entity: Entity,
  field: string,
  row?: InheritedRow,
): SQL<{ source: number; id: string } | null> =>
  atRow(entity, row, (alias, depth) => {
    const { from, row: decided } = fallbackRowSql(
      entity,
      requireChain(entity, field),
      alias,
      depth,
    );
    return sql`(SELECT json_build_object('source', ${decided}.prio, 'id', ${decided}.src) FROM ${from})`;
  }) as SQL<{ source: number; id: string } | null>;

/** The entity whose record a declared source names in provenance. */
export const inheritedSourceEntity = (
  entity: Entity,
  field: string,
  source: number,
): Entity => {
  const declared = requireChain(entity, field).from[source - 1];
  if (declared === undefined)
    throw new Error(`${entity}.${field} declares no source ${source}`);
  return declared.kind === "hierarchy"
    ? entity
    : (declared.hops.at(-1)?.target ?? entity);
};

/**
 * Whether the record `rowId` names has an effective value in `values` (a SQL
 * value list), in the top-down set form: the records that decide one of the
 * values, then their live descendants that do not decide, resolved once per
 * query rather than walked per row. Only a chain that inherits through its
 * hierarchy alone has this form; null otherwise, and the caller compares
 * `effectiveFieldSql` instead.
 */
export const effectiveFieldInSql = (
  entity: Entity,
  field: string,
  rowId: SQL,
  values: SQL,
): SQL<boolean> | null => {
  const chain = requireChain(entity, field);
  const [source, ...rest] = chain.from;
  if (source?.kind !== "hierarchy" || rest.length > 0 || chain.empty !== null)
    return null;
  const { table, softDelete } = tableOf(entity);
  const set = name("ih0s");
  const node = "ih0n";
  return sql<boolean>`COALESCE(${rowId} IN (
    WITH RECURSIVE ${set} AS (
      SELECT ${ref(node, "id")}, 0 AS ih_depth, ARRAY[${ref(node, "id")}] AS ih_visited
      FROM ${table} ${name(node)}
      WHERE ${ownDecides(chain, node)} AND ${ownValue(chain, node)} IN (${values})${live(node, softDelete)}
      UNION ALL
      SELECT ${ref(node, "id")}, ${set}."ih_depth" + 1, ${set}."ih_visited" || ${ref(node, "id")}
      FROM ${set} JOIN ${table} ${name(node)} ON ${ref(node, source.parentColumn)} = ${set}."id"
      WHERE NOT ${ownDecides(chain, node)} AND ${set}."ih_depth" < ${sql.raw(String(source.maxDepth))}
        AND NOT ${ref(node, "id")} = ANY(${set}."ih_visited")${live(node, softDelete)}
    ) SELECT "id" FROM ${set}
  ), false)`;
};
