import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import {
  listGroupMarginSchema,
  listGroupMembershipSchema,
  listGroupSummarySchema,
} from "@cubby/schemas/pagination";
import { sql, type SQL } from "drizzle-orm";
import type { PgSelect, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers/core";

import type { ListGroupSql } from "./field-compiler";

const resultSchema = z.object({
  ids: z.array(z.string()),
  count: z.number().int().nonnegative(),
  membershipCount: z.number().int().nonnegative(),
  memberships: z.array(listGroupMembershipSchema),
  groups: z.array(listGroupSummarySchema),
  margins: z.array(listGroupMarginSchema),
});

/** The non-prefix dimension combinations a pivot's totals read. */
const marginDimensions = (depth: number): number[][] =>
  depth === 3 ? [[1], [0, 2]] : depth === 2 ? [[1]] : [];

/** Page expanded SQL memberships, then hydrate each selected canonical root once. */
export async function readGroupedQuery(input: {
  db: Database | DrizzleTransaction;
  source: PgTable | SQL;
  id: SQL;
  code: SQL;
  where: SQL | undefined;
  joins?: (query: PgSelect) => PgSelect;
  groups: readonly ListGroupSql[];
  metrics: readonly { key: string; value: SQL }[];
  order: readonly SQL[];
  limit: number;
  offset: number;
}) {
  const { db, groups, metrics } = input;
  const selection = {
    id: input.id,
    code: input.code,
    path: sql`ARRAY[${sql.join(
      groups.map((group) => sql`coalesce(${group.key}::text, ${FILTER_NONE})`),
      sql`, `,
    )}]::text[]`,
    labels: sql`ARRAY[${sql.join(
      groups.map((group) => {
        const value = group.choice.value;
        const options =
          value !== null && "options" in value ? value.options : null;
        const optionLabel = options?.length
          ? sql`CASE ${group.key} ${sql.join(
              options.map(
                (option) => sql`WHEN ${option.value} THEN ${option.label}`,
              ),
              sql` `,
            )} ELSE ${group.key}::text END`
          : group.key;
        const label =
          group.label === null
            ? optionLabel
            : sql`coalesce(${group.label}::text, ${optionLabel}::text)`;
        return sql`CASE WHEN ${group.key} IS NULL THEN ${group.choice.noValueLabel} ELSE coalesce(${label}::text, ${group.key}::text) END`;
      }),
      sql`, `,
    )}]::text[]`,
    subtrees: sql`ARRAY[${sql.join(
      groups.map((group) => group.subtree ?? sql`false`),
      sql`, `,
    )}]::boolean[]`,
    ordinal: sql`row_number() OVER (ORDER BY ${sql.join([...input.order], sql`, `)})`,
    ...Object.fromEntries(
      metrics.map((metric, index) => [`m${index}`, metric.value]),
    ),
  };
  const initial = unwrapDb(db).select(selection).from(input.source).$dynamic();
  let query: PgSelect = input.joins ? input.joins(initial) : initial;
  for (const [index, group] of groups.entries()) {
    if (group.members)
      query = query.leftJoin(
        sql`LATERAL (${group.members}) ${sql.identifier(`list_group_${index}`)}`,
        sql`true`,
      );
  }
  const expanded = query.where(input.where);
  const metricColumns = metrics.map((_, index) => sql.identifier(`m${index}`));
  const extraColumns = metricColumns.length
    ? sql`, ${sql.join(metricColumns, sql`, `)}`
    : sql``;
  const metricObject = metrics.length
    ? sql`jsonb_build_object(${sql.join(
        metrics.flatMap((metric, index) => [
          sql`${metric.key}::text`,
          sql`jsonb_build_object('sum', sum(${sql.identifier(`m${index}`)})::double precision, 'presentCount', count(${sql.identifier(`m${index}`)})::int, 'totalCount', count(*)::int, 'coverage', count(${sql.identifier(`m${index}`)})::double precision / nullif(count(*), 0))`,
        ]),
        sql`, `,
      )})`
    : sql`'{}'::jsonb`;
  // A root contributes once per prefix, even when several expanded leaves
  // share it. This also prevents overlapping paths from multiplying money.
  const prefixes = sql.join(
    groups.map((_, index) => {
      // Bounds are compiler-owned integers. Bind parameters would give SELECT
      // and GROUP BY different expression identities in PostgreSQL.
      const depth = sql.raw(String(index + 1));
      return sql`
      SELECT id, path[1:${depth}] AS path, labels[1:${depth}] AS labels,
        bool_or(coalesce(subtrees[${depth}], false)) AS subtree, min(ordinal) AS ordinal${extraColumns}
      FROM memberships GROUP BY id, path[1:${depth}], labels[1:${depth}]${extraColumns}
    `;
    }),
    sql` UNION ALL `,
  );
  // Distinct roots per combination, like prefixes: a record holding several
  // values in another dimension still counts once in its column total.
  const marginSets = marginDimensions(groups.length);
  const margins = marginSets.length
    ? sql.join(
        marginSets.map((dimensions) => {
          const parts = dimensions.map(
            (dimension) => sql`path[${sql.raw(String(dimension + 1))}]`,
          );
          const key = sql`ARRAY[${sql.join(parts, sql`, `)}]::text[]`;
          return sql`SELECT ${sql.raw(`'${JSON.stringify(dimensions)}'`)}::jsonb AS dimensions, ${key} AS path, count(DISTINCT id)::int AS count FROM memberships GROUP BY ${key}`;
        }),
        sql` UNION ALL `,
      )
    : sql`SELECT NULL::jsonb AS dimensions, NULL::text[] AS path, 0 AS count WHERE false`;
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON keys name the grouping response contract.
  const relation = sql`(
    WITH expanded(id, code, path, labels, subtrees, ordinal${extraColumns}) AS (${expanded}),
    memberships AS (
      SELECT id, code, path, labels, ARRAY[${sql.join(
        groups.map(
          (_, index) => sql`bool_or(coalesce(subtrees[${index + 1}], false))`,
        ),
        sql`, `,
      )}]::boolean[] AS subtrees, min(ordinal) AS ordinal${extraColumns}
      FROM expanded GROUP BY id, code, path, labels${extraColumns}
    ),
    prefixes AS (${prefixes}),
    summaries AS (
      SELECT path, labels[cardinality(path)] AS label, count(*)::int AS count,
        bool_or(subtree) AS subtree, min(ordinal) AS ordinal, ${metricObject} AS metrics
      FROM prefixes GROUP BY path, labels[cardinality(path)]
    ),
    margins AS (${margins}),
    population AS (SELECT count(DISTINCT id)::int AS count, count(*)::int AS membership_count FROM memberships),
    page AS (SELECT * FROM memberships ORDER BY ordinal LIMIT ${input.limit} OFFSET ${input.offset})
    SELECT jsonb_build_object(
      'ids', coalesce((SELECT jsonb_agg(id ORDER BY ordinal) FROM (SELECT id, min(ordinal) ordinal FROM page GROUP BY id) ids), '[]'::jsonb),
      'count', population.count,
      'membershipCount', population.membership_count,
      'memberships', coalesce((SELECT jsonb_agg(jsonb_build_object('id', code, 'path', path) ORDER BY ordinal) FROM page), '[]'::jsonb),
      'groups', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'key', array_to_json(s.path)::text, 'path', s.path, 'label', s.label, 'count', s.count,
        'parentCount', coalesce(parent.count, population.count),
        'fraction', s.count::double precision / nullif(coalesce(parent.count, population.count), 0),
        'overlapping', (SELECT sum(sibling.count) FROM summaries sibling WHERE sibling.path[1:cardinality(sibling.path)-1] = s.path[1:cardinality(s.path)-1] AND cardinality(sibling.path) = cardinality(s.path)) > coalesce(parent.count, population.count),
        'subtree', s.subtree, 'metrics', s.metrics
      ) ORDER BY s.ordinal, cardinality(s.path)) FROM summaries s LEFT JOIN summaries parent ON parent.path = s.path[1:cardinality(s.path)-1]), '[]'::jsonb),
      'margins', coalesce((SELECT jsonb_agg(jsonb_build_object('dimensions', m.dimensions, 'path', m.path, 'count', m.count)) FROM margins m), '[]'::jsonb)
    ) AS payload FROM population
  ) grouped_query`;
  const [row] = await unwrapDb(db)
    .select({ payload: sql<unknown>`grouped_query.payload` })
    .from(relation);
  return resultSchema.parse(row?.payload);
}
