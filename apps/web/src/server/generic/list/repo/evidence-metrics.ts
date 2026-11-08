import type { Entity } from "@cubby/schemas/entity";
import type { EntityDeclarationMetadata } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { GeneratedRowSet } from "@cubby/schemas/entity-projection-types";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupBy } from "@cubby/schemas/pagination";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  type AnyRowsSql,
  ListContext,
  repositoryRowSetSql,
} from "~/server/generic/list/repo/field-compiler";
import { hierarchyAncestorSql } from "~/server/generic/list/repo/hierarchy";

/**
 * Evidence is independent of expanded memberships. Every prefix, Pivot margin
 * and global total selects contributor identities from this same relation.
 * Equal amounts are different contributions; repeated paths to one identity
 * are not. The caller supplies `memberships(id, path)` for the filtered roots.
 */
export function compileEvidenceMetrics(input: {
  entity: Entity;
  groupBy: readonly ListGroupBy[];
  rows: AnyRowsSql;
  context: ListContext;
}) {
  const facts = generatedEntityListFields[input.entity];
  const metrics: readonly EntityDeclarationMetadata["presentation"]["list"]["evidenceMetrics"][number][] =
    facts.evidenceMetrics;
  const rowSets: Readonly<Record<string, GeneratedRowSet>> = facts.rows;
  const sourceKeys = [...new Set(metrics.map((metric) => metric.rows))];
  const sources = sourceKeys.map((key, index) => {
    return sql`${sql.identifier(`evidence_rows_${index}`)} AS (
      SELECT row_set.* FROM (${repositoryRowSetSql(input.entity, key, input.rows, input.context)}) row_set
      WHERE row_set.owner IN (SELECT id FROM memberships)
    )`;
  });
  const ctes = [
    ...sources,
    ...metrics.map((metric, index) => {
      const rowSet = rowSets[metric.rows];
      if (rowSet?.storage.kind !== "repository")
        throw new Error(
          `${input.entity}.${metric.key} needs repository evidence`,
        );
      const storage = rowSet.storage;
      const column = (name: string) => sql`row_set.${sql.identifier(name)}`;
      const bindings = input.groupBy.map((dimension) => {
        const field = metric.bindings[dimension.key];
        if (field === undefined) return sql`NULL::text`;
        const target = storage.columns[field];
        if (target === null || target === undefined)
          throw new Error(`${metric.key}.${field} needs a canonical reference`);
        const manifest = entityManifest[target];
        if (manifest.dbTable === null)
          throw new Error(`${target} has no table`);
        const id =
          dimension.level === undefined
            ? column(field)
            : hierarchyAncestorSql(target, column(field), dimension.level);
        return sql`coalesce((SELECT evidence_target."shortcode" FROM ${sql.identifier(manifest.dbTable)} evidence_target WHERE evidence_target."id" = ${id}${manifest.softDelete ? sql` AND ${notDeleted("evidence_target")}` : sql``}), ${FILTER_NONE})::text`;
      });
      // Identity bindings can contain subqueries. Resolve them once per
      // contributor, rather than inlining them into every coordinate join.
      return sql`${sql.identifier(`evidence_${index}`)} AS MATERIALIZED (
      SELECT row_set.owner, ${column(metric.identity)}::text AS identity,
        ${column(metric.value)}::numeric AS value,
        ARRAY[${sql.join(bindings, sql`, `)}]::text[] AS bindings
      FROM ${sql.identifier(`evidence_rows_${sourceKeys.indexOf(metric.rows)}`)} row_set
      WHERE ${metric.where === undefined ? sql`true` : column(metric.where)}
    )`;
    }),
  ];
  return (scopes: readonly (readonly number[])[]) => {
    // One coordinate per root and scope, irrespective of overlapping leaves.
    const coordinates = sql`metric_coordinates AS (${sql.join(
      scopes.map((dimensions) => {
        const indexes = dimensions.map((dimension) =>
          sql.raw(String(dimension)),
        );
        const path = dimensions.map(
          (dimension) => sql`m.path[${sql.raw(String(dimension + 1))}]`,
        );
        return sql`SELECT DISTINCT id, ARRAY[${sql.join(indexes, sql`, `)}]::int[] AS dimensions,
        ARRAY[${sql.join(path, sql`, `)}]::text[] AS path FROM memberships m`;
      }),
      sql` UNION ALL `,
    )})`;
    const totals = metrics.map((_, index) => {
      const bindings = input.groupBy.map((_, dimension) => {
        const slot = sql.raw(String(dimension + 1));
        const axis = sql.raw(String(dimension));
        return sql`(e.bindings[${slot}] IS NULL OR ${axis} <> ALL(c.dimensions)
          OR e.bindings[${slot}] = c.path[array_position(c.dimensions, ${axis})])`;
      });
      // Expense identities are distinct within every coordinate. Equal values
      // on different identities remain separate, including signed refunds.
      return sql`${sql.identifier(`evidence_totals_${index}`)} AS (
        SELECT dimensions, path, jsonb_build_object(
          'sum', sum(value)::double precision, 'presentCount', count(value)::int,
          'totalCount', count(*)::int,
          'coverage', count(value)::double precision / nullif(count(*), 0)) AS value
        FROM (SELECT DISTINCT c.dimensions, c.path, e.identity, e.value
          FROM metric_coordinates c JOIN ${sql.identifier(`evidence_${index}`)} e ON e.owner = c.id
          WHERE ${bindings.length ? sql.join(bindings, sql` AND `) : sql`true`}) contributors
        GROUP BY dimensions, path
      )`;
    });
    const all = [...ctes, coordinates, ...totals];
    return {
      ctes: metrics.length ? sql`, ${sql.join(all, sql`, `)}` : sql``,
      object: (dimensions: "prefix" | readonly number[], path: SQL): SQL => {
        if (metrics.length === 0) return sql`'{}'::jsonb`;
        const axes =
          dimensions === "prefix"
            ? sql`ARRAY(SELECT generate_series(0, cardinality(${path}) - 1))::int[]`
            : sql`ARRAY[${sql.join(
                dimensions.map((dimension) => sql.raw(String(dimension))),
                sql`, `,
              )}]::int[]`;
        return sql`jsonb_build_object(${sql.join(
          metrics.flatMap((metric, index) => [
            sql`${metric.key}::text`,
            // An absent contributor group is a known zero. A present group
            // containing only NULL values keeps its NULL sum and zero coverage.
            sql`coalesce((SELECT metric_total.value FROM ${sql.identifier(`evidence_totals_${index}`)} metric_total
            WHERE metric_total.dimensions = ${axes} AND metric_total.path = ${path}),
            jsonb_build_object('sum', 0, 'presentCount', 0, 'totalCount', 0, 'coverage', NULL))`,
          ]),
          sql`, `,
        )})`;
      },
    };
  };
}
