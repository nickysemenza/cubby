import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ProjectFilters, ProjectOut } from "@cubby/schemas/project";
import { projectSortableFields } from "@cubby/schemas/project";
import { eq, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
} from "~/server/repo/database-helpers";
import { projectDependencyIds, projectRollups } from "./analytics";
import { dbProjectToAPI, EMPTY_PROJECT_ROLLUP } from "./helpers";

export const projectList = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: ProjectOut[]; count: number }> => {
  const whereClause = buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    [
      filters.status ? eq(project.status, filters.status) : undefined,
      filters.kind ? eq(project.kind, filters.kind) : undefined,
      // `locations` is a free-form text[] column — exact-match membership.
      filters.location
        ? sql`${filters.location} = ANY(${project.locations})`
        : undefined,
    ],
  );

  const orderByArray = buildOrderBy(project, sorts, [...projectSortableFields]);
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.project.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    countWhere(db, project, whereClause),
  );

  const ids = rows.map((r) => r.id);
  const [rollups, deps] = await Promise.all([
    projectRollups(db, ids),
    projectDependencyIds(db, ids),
  ]);

  const data = rows.map((row) =>
    dbProjectToAPI(
      row,
      rollups.get(row.id) ?? EMPTY_PROJECT_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
    ),
  );

  return { data, count };
};
