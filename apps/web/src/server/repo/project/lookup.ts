import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProjectFilters,
  ProjectOptionsOut,
  ProjectOut,
} from "@cubby/schemas/project";
import { projectSortableFields } from "@cubby/schemas/project";
import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import { projectDependencyIds, projectRollups } from "./analytics";
import {
  dbProjectToAPI,
  EMPTY_PROJECT_OWN_ROLLUP,
  EMPTY_PROJECT_SUBTREE_ROLLUP,
} from "./helpers";
import {
  aggregateSubtreeRollups,
  allProjectParentRows,
  buildChildrenMap,
  collectDescendantIds,
} from "./subtree";

/**
 * Lightweight `{id, name}` options for pickers/filter selects — a single
 * indexed query with no rollup/dependency joins. Feeds `project.options`
 * (see `useProjectOptions`), which used to page through the full `list`
 * (rollups + deps) at pageSize 500 just to get names.
 */
export const projectNameOptions = async (
  db: Database,
): Promise<ProjectOptionsOut[]> =>
  getDb(db)
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(notDeleted(project))
    .orderBy(asc(project.name));

export const projectList = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: ProjectOut[]; count: number }> => {
  // Whole-tree parent/child map — cheap single query — see subtree.ts's doc
  // comment. Fetched up front so it can also resolve `includeSubProjects`
  // below; own rollups are then only fetched for this page's projects plus
  // their descendants (never the whole tree), and aggregated in TS.
  const allRows = await allProjectParentRows(db);
  const childrenByParent = buildChildrenMap(allRows);

  // When scoped to a parent's subtree, resolve every live descendant id and
  // match on that set (excluding the parent itself — same shape as the plain
  // `parentProjectId` filter, just recursive); otherwise a direct-children match.
  let parentCondition = filters.parentProjectId
    ? eq(project.parentProjectId, filters.parentProjectId)
    : undefined;
  if (filters.parentProjectId && filters.includeSubProjects) {
    const descendantIds = collectDescendantIds(
      childrenByParent,
      filters.parentProjectId,
    );
    parentCondition = inArray(project.id, descendantIds);
  }

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
      filters.topLevelOnly ? isNull(project.parentProjectId) : undefined,
      parentCondition,
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
  const nameById = new Map(allRows.map((r) => [r.id, r.name]));
  const descendantIds = ids.flatMap((id) =>
    collectDescendantIds(childrenByParent, id),
  );

  const [rollups, deps] = await Promise.all([
    projectRollups(db, uniq([...ids, ...descendantIds])),
    projectDependencyIds(db, ids),
  ]);
  const subtreeRollups = aggregateSubtreeRollups(allRows, rollups);

  const data = rows.map((row) =>
    dbProjectToAPI(
      row,
      rollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
      subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      row.parentProjectId ? (nameById.get(row.parentProjectId) ?? null) : null,
      childrenByParent.get(row.id) ?? [],
    ),
  );

  return { data, count };
};
