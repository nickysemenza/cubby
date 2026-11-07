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
  rowSetSql,
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
    const set = rowSetSql(
      input.entity,
      key,
      "metric_root",
      input.rows,
      input.context,
    );
    return sql`${sql.identifier(`evidence_rows_${index}`)} AS (
      SELECT evidence.* FROM (SELECT DISTINCT id FROM memberships) metric_root
      CROSS JOIN LATERAL (${set.select(sql`row_set.*`)}) evidence
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
      return sql`${sql.identifier(`evidence_${index}`)} AS (
      SELECT row_set.owner, ${column(metric.identity)}::text AS identity,
        ${column(metric.value)}::numeric AS value,
        ARRAY[${sql.join(bindings, sql`, `)}]::text[] AS bindings
      FROM ${sql.identifier(`evidence_rows_${sourceKeys.indexOf(metric.rows)}`)} row_set
      WHERE ${metric.where === undefined ? sql`true` : column(metric.where)}
    )`;
    }),
  ];
  return {
    /** Append after the caller's membership CTE. */
    ctes: ctes.length ? sql`, ${sql.join(ctes, sql`, `)}` : sql``,
    /** `prefix` reads the depth from path; explicit dimensions serve margins. */
    object: (dimensions: "prefix" | readonly number[], path: SQL): SQL => {
      if (metrics.length === 0) return sql`'{}'::jsonb`;
      return sql`jsonb_build_object(${sql.join(
        metrics.flatMap((metric, index) => {
          const match =
            dimensions === "prefix"
              ? sql`m.path[1:cardinality(${path})] = ${path}`
              : dimensions.length
                ? sql`ARRAY[${sql.join(
                    dimensions.map(
                      (dimension) => sql`m.path[${dimension + 1}]`,
                    ),
                    sql`, `,
                  )}]::text[] = ${path}`
                : sql`true`;
          const bindings = input.groupBy.map((_, dimension) => {
            if (dimensions !== "prefix" && !dimensions.includes(dimension))
              return sql`true`;
            const at = sql.raw(String(dimension + 1));
            return sql`(${dimensions === "prefix" ? sql`${at} > cardinality(${path}) OR` : sql``}
            evidence.bindings[${at}] IS NULL OR evidence.bindings[${at}] = m.path[${at}])`;
          });
          // One identity per coordinate scope, independent of membership count.
          // A NULL cost is unknown; an empty evidence set is a known zero.
          return [
            sql`${metric.key}::text`,
            sql`(
          SELECT jsonb_build_object(
            'sum', CASE WHEN count(*) = 0 THEN 0 ELSE sum(value)::double precision END,
            'presentCount', count(value)::int, 'totalCount', count(*)::int,
            'coverage', count(value)::double precision / nullif(count(*), 0))
          FROM (SELECT DISTINCT identity, value FROM ${sql.identifier(`evidence_${index}`)} evidence
            WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.id = evidence.owner AND ${match}
              ${bindings.length ? sql`AND ${sql.join(bindings, sql` AND `)}` : sql``})) contributors
        )`,
          ];
        }),
        sql`, `,
      )})`;
    },
  };
}
