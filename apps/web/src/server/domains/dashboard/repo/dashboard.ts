import {
  dashboardLocalCounts,
  type DashboardLocalCounts,
} from "@cubby/schemas/dashboard";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { type SQL, sql } from "drizzle-orm";

import {
  listEntities,
  parseEntityListInput,
} from "~/entity/generated/entity-lists.gen";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import { jobEntityWhere } from "~/server/generic/jobs/repo/entity-list";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-utils";

type LocalCountEntity = keyof DashboardLocalCounts;

/**
 * The WHERE behind each entity's homepage/footer/`/entities` total: the
 * entity's own list scaffold over its declared opening filter
 * (`presentation.list.initialFilter`), so a total counts exactly what the
 * list opens on. Each declared opening filter is keyed by its list filter
 * key, so it parses as the request's filter record. Job keeps its own read.
 */
const countWhere = (entity: LocalCountEntity): SQL | undefined => {
  if (entity === "job") return jobEntityWhere({});
  const listEntity = listEntities.find((candidate) => candidate === entity);
  const scaffold = kernelScaffold(entity);
  if (!listEntity || !scaffold)
    throw new Error(`No list scaffold counts ${entity}`);
  const { filters } = parseEntityListInput(listEntity, {
    entity: listEntity,
    filters: Object.fromEntries(
      entitySummary[listEntity].list.initialFilter.map((filter) => [
        filter.id,
        filter.value,
      ]),
    ),
  });
  return scaffold.where(filters);
};

type EntityCounts = Record<LocalCountEntity, number>;

const localCountEntities = dashboardLocalCounts.keyof().options;
const entityCountsSchema = dashboardLocalCounts;

/**
 * Live row count for every local browser list, as one round-trip of cheap scalar
 * `COUNT(*)` subqueries — NO list fetch and NO USDA enrichment. Driven by the
 * shared dashboard local-count schema;
 * one query (not N) because N parallel counts overran the per-request pool
 * (max 5). The homepage still reads only `countableEntities` from this result.
 * Filtered counts stay on the `*.list` procedures.
 */
export const getEntityCounts = async (db: Database): Promise<EntityCounts> => {
  const whereByEntity = new Map(
    localCountEntities.map((entity) => [entity, countWhere(entity)] as const),
  );

  const countCol = (entity: LocalCountEntity): SQL => {
    const where = whereByEntity.get(entity);
    const from = sql`${SHORTCODE_TABLE[entity]}`;
    return where
      ? sql`(SELECT count(*)::int FROM ${from} WHERE ${where})`
      : sql`(SELECT count(*)::int FROM ${from})`;
  };

  const fragments = localCountEntities.map(
    (entity) => sql`${countCol(entity)} AS ${sql.identifier(entity)}`,
  );

  const res = await getDb(db).execute<Record<string, number>>(
    sql`SELECT ${sql.join(fragments, sql`, `)}`,
  );
  const row = res.rows[0];

  return entityCountsSchema.parse(
    Object.fromEntries(
      localCountEntities.map((entity) => [entity, row?.[entity] ?? 0]),
    ),
  );
};
