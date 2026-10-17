/**
 * The effective value of a field that declares `resolution.inherit`: one
 * SQL expression for every read, filter, sort and group, so they cannot
 * disagree. Repositories keep `fieldResolutions` provenance (source,
 * stored and fallback values) and read the value from here.
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
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { type SQL, sql } from "drizzle-orm";

/** The row an effective value reads: a table alias in scope, or its id. */
export type InheritedRow = string | { readonly id: SQL };

type Source = GeneratedInherit["from"][number];
type Hop = Extract<Source, { kind: "stored" }>["hops"][number];

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

const defaultAlias = (entity: Entity) => {
  const { dbTable } = entityManifest[entity];
  if (dbTable === null) throw new Error(`${entity} has no table to inherit from`);
  return dbTable;
};

const tableOf = (entity: Entity) => {
  const { dbTable, softDelete } = entityManifest[entity];
  if (dbTable === null) throw new Error(`${entity} has no table to inherit from`);
  return { table: sql.raw(`"${dbTable}"`), softDelete };
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
  if (where === undefined) throw new Error(`${entity} inherits through no path`);
  return {
    tables: sql.join(tables, sql` `),
    where,
    leaf: currentAlias,
    target: current,
  };
};

/**
 * The value an inherited field's own chain decides at a record, as a
 * subquery that yields one `v` row exactly when something decides (its own
 * value or a source). A field without a chain decides when it is not NULL.
 */
const decisionSql = (
  entity: Entity,
  field: string,
  alias: string,
  depth: number,
): SQL => {
  const chain = chainOf(entity, field);
  if (chain === null) {
    const column = ref(alias, columnOf(entity, field));
    return sql`SELECT ${column} AS v WHERE ${column} IS NOT NULL`;
  }
  return sql`SELECT ${name(`ih${depth}d`)}.v FROM (SELECT 0 AS prio, ${ownValue(chain, alias)} AS v WHERE ${ownDecides(chain, alias)}${sql.join(
    chain.from.map(
      (source, index) =>
        sql` UNION ALL ${sourceSql(entity, field, chain, source, index + 1, alias, depth)}`,
    ),
    sql``,
  )}) ${name(`ih${depth}d`)} ORDER BY ${name(`ih${depth}d`)}.prio LIMIT 1`;
};

const columnOf = (entity: Entity, field: string): string => {
  const column = generatedStorage(entity).find(({ key }) => key === field)
    ?.column;
  if (column === undefined)
    throw new Error(`${entity}.${field} is not a stored field`);
  return column;
};

const generatedStorage = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1]
    .storage ?? [];

/** One source's decision as a `(prio, v)` row, present when it decides. */
const sourceSql = (
  entity: Entity,
  field: string,
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
      return sql`SELECT ${rank} AS prio, ${name(`ih${depth}a${prio}`)}.v FROM (
        WITH RECURSIVE ${name(walk)} AS (
          SELECT ${select(node)}, 1 AS ih_depth, ARRAY[${ref(alias, "id")}, ${ref(node, "id")}] AS ih_visited
          FROM ${table} ${name(node)}
          WHERE ${ref(node, "id")} = ${ref(alias, source.parentColumn)}${live(node, softDelete)}
          UNION ALL
          SELECT ${select(node)}, ${ref(walk, "ih_depth")} + 1, ${ref(walk, "ih_visited")} || ${ref(node, "id")}
          FROM ${table} ${name(node)} JOIN ${name(walk)} ON ${ref(node, "id")} = ${ref(walk, source.parentColumn)}
          WHERE ${ref(walk, "ih_depth")} < ${sql.raw(String(source.maxDepth))}
            AND NOT ${ref(node, "id")} = ANY(${ref(walk, "ih_visited")})${live(node, softDelete)}
        )
        SELECT ${ownValue(chain, walk)} AS v FROM ${name(walk)}
        WHERE ${ownDecides(chain, walk)} ORDER BY ${ref(walk, "ih_depth")} LIMIT 1
      ) ${name(`ih${depth}a${prio}`)}`;
    }
    case "stored": {
      const path = pathFrom(entity, source.hops, alias, depth, `s${prio}p`);
      const target = requireChain(path.target, field);
      return sql`SELECT ${rank} AS prio, ${ownValue(target, path.leaf)} AS v FROM ${path.tables} WHERE ${path.where} AND ${ownDecides(target, path.leaf)}`;
    }
    case "effective": {
      const path = pathFrom(entity, source.hops, alias, depth, `s${prio}p`);
      const decided = name(`ih${depth}e${prio}`);
      return sql`SELECT ${rank} AS prio, ${decided}.v FROM ${path.tables} CROSS JOIN LATERAL (${decisionSql(path.target, source.field, path.leaf, depth + 1)}) ${decided} WHERE ${path.where}`;
    }
  }
};

/** The effective value over a row alias, starting nested aliases at `depth`. */
const effectiveSql = (
  entity: Entity,
  field: string,
  alias: string,
  depth: number,
): SQL => {
  const chain = requireChain(entity, field);
  const fallback = inheritedSql(entity, field, chain, alias, depth);
  const value = sql`CASE WHEN ${ownDecides(chain, alias)} THEN ${ownValue(chain, alias)} ELSE ${fallback} END`;
  return chain.empty === "array" ? sql`COALESCE(${value}, '{}')` : value;
};

/** The value the chain's sources decide, ignoring the row's own. */
const inheritedSql = (
  entity: Entity,
  field: string,
  chain: GeneratedInherit,
  alias: string,
  depth: number,
): SQL => {
  const branches = chain.from.map((source, index) =>
    sourceSql(entity, field, chain, source, index + 1, alias, depth),
  );
  const union = name(`ih${depth}u`);
  return sql`(SELECT ${union}.v FROM (${sql.join(branches, sql` UNION ALL `)}) ${union} ORDER BY ${union}.prio LIMIT 1)`;
};

const atRow = (
  entity: Entity,
  row: InheritedRow | undefined,
  render: (alias: string, depth: number) => SQL,
): SQL => {
  if (row === undefined || typeof row === "string")
    return render(row ?? defaultAlias(entity), 1);
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
    inheritedSql(entity, field, requireChain(entity, field), alias, depth),
  ) as SQL<T>;
