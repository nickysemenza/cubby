/** Temporary Assessment source relevance owner; B3 retires this target. No execution state. */
import { sql, type SQL } from "drizzle-orm";

import {
  isFanoutInput,
  type InternalStoredDerivedDeclaration,
  type DerivedInput,
  type DerivedPathStep,
} from "~/server/db/derived-declarations";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { DerivedFanoutSelection } from "~/server/generic/derived/repo/compute";

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);
const fixedTargetRows = (
  table: string,
  where: Readonly<Record<string, string | null | readonly string[]>>,
) =>
  sql`SELECT id FROM ${ident(table)} WHERE ${sql.join(
    Object.entries(where).map(([column, value]) =>
      value === null
        ? sql`${ident(column)} IS NULL`
        : typeof value === "string"
          ? sql`${ident(column)} = ${value}`
          : value.length === 0
            ? sql`false`
            : sql`${ident(column)} IN (${sql.join(
                value.map((item) => sql`${item}`),
                sql`, `,
              )})`,
    ),
    sql` AND `,
  )}`;

const pathReference = (column: string, jsonKey: string | undefined): SQL => {
  if (!jsonKey) return ident(column);
  const value = sql`(${ident(column)} ->> ${jsonKey})`;
  const uuidType = "uuid";
  return sql`CASE WHEN pg_input_is_valid(${value}, ${uuidType}) THEN ${value}::uuid END`;
};

/** Values reached from `start` along a join path, as one nested subquery. */
const pathSql = (path: readonly DerivedPathStep[], start: SQL): SQL =>
  path.reduce<SQL>((previous, step) => {
    if (step.recursive) {
      // Include source IDs even after deletion; canonical compute owns liveness.
      const edge = (column: string) => sql`edge.${ident(column)}`;
      return sql`WITH RECURSIVE derived_path_walk(id, depth, visited) AS (
          SELECT DISTINCT seed.id, 0, ARRAY[seed.id] FROM (${previous}) seed(id)
          WHERE seed.id IS NOT NULL
          UNION ALL
          SELECT ${edge(step.to)}, walk.depth + 1, array_append(walk.visited, ${edge(step.to)})
          FROM ${ident(step.table)} edge JOIN derived_path_walk walk ON ${edge(step.from)} = walk.id
          WHERE walk.depth < ${step.recursive.maxDepth}
            AND ${edge(step.to)} IS NOT NULL AND NOT (${edge(step.to)} = ANY(walk.visited))
            ${sql.join(Object.entries(step.where ?? {}).map(([column, value]) => sql` AND ${edge(column)} = ${value}`))}
        ) SELECT DISTINCT id FROM derived_path_walk`;
    }
    return sql`SELECT ${pathReference(step.to, step.jsonKey)}
        FROM ${ident(step.table)}
        WHERE ${pathReference(step.from, step.fromJsonKey)} IN (${previous})${sql.join(
          Object.entries(step.where ?? {}).map(
            ([column, value]) => sql` AND ${ident(column)} = ${value}`,
          ),
        )}`;
  }, start);

function fanoutRows(
  declaration: InternalStoredDerivedDeclaration,
  input: DerivedInput,
  refs: SQL,
  select: DerivedFanoutSelection | undefined,
): SQL {
  if (input.selection) {
    if (!select)
      throw new Error(
        `Missing internal source selector: ${declaration.target}`,
      );
    const sourceRefs = input.selection.path
      ? pathSql(input.selection.path, refs)
      : refs;
    return sql`WITH derived_fanout_refs(id) AS MATERIALIZED (${sourceRefs})
      SELECT current_targets.id FROM (${select(sql`SELECT id FROM derived_fanout_refs`)}) current_targets`;
  }
  if (input.targetWhere)
    return fixedTargetRows(declaration.table, input.targetWhere);
  if (input.paths)
    return sql.join(
      input.paths.map((path) => sql`(${pathSql(path, refs)})`),
      sql` UNION `,
    );
  if (input.path) return pathSql(input.path, refs);
  return sql`SELECT d.id FROM ${ident(declaration.table)} d WHERE d.${ident(input.entityColumn)} IN (${refs})`;
}

/** A sink's expansion and source fence share current-and-retained selectors. */
export function derivedFanoutSourceScope({
  declaration,
  selections,
  dependentIds,
  sourceRefs,
  sourceTargets,
}: {
  declaration: InternalStoredDerivedDeclaration;
  selections: Readonly<Record<string, DerivedFanoutSelection>>;
  dependentIds: readonly string[];
  /** Snapshot input identities survive a move that changes the live selector. */
  sourceRefs: ReadonlyMap<string, readonly string[]>;
  /** Excluded or unknown inputs keep the conservative target-wide fence. */
  sourceTargets?: ReadonlySet<string>;
}): (source: { target: SQL; ref: SQL }) => SQL {
  const inputs = declaration.inputs.flatMap((input, index) => {
    if (!isFanoutInput(input)) return [];
    const target = `${declaration.target}@${index}`;
    if (sourceTargets && !sourceTargets.has(target)) return [];
    const select = input.selection
      ? selections[input.selection.key]
      : undefined;
    return [
      { target, input, select, refs: [...(sourceRefs.get(target) ?? [])] },
    ];
  });
  const members = [...dependentIds];
  return ({ target, ref }) =>
    inputs.length === 0
      ? sql`true`
      : sql`CASE ${target}
    ${sql.join(
      inputs.map(
        (source) => sql`WHEN ${source.target} THEN (
      ${ref} = ANY(${uuidArrayParam(source.refs)}) OR EXISTS (
      SELECT 1 FROM (${fanoutRows(
        declaration,
        source.input,
        sql`SELECT ${ref}::uuid AS id`,
        source.select,
      )}) affected(id)
      WHERE affected.id = ANY(${uuidArrayParam(members)})
    ))`,
      ),
      sql` `,
    )}
    ELSE true END`;
}
