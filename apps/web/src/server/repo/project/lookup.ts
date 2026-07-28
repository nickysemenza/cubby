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
import { projectDependencyIds } from "./analytics";
import {
  dbProjectToAPI,
  EMPTY_PROJECT_OWN_ROLLUP,
  EMPTY_PROJECT_SUBTREE_ROLLUP,
} from "./helpers";
import {
  collectDescendantIds,
  loadProjectSubtreeRollups,
  loadProjectTree,
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
    .select({
      id: project.id,
      name: project.name,
      startDate: project.startDate,
      endDate: project.endDate,
    })
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
  // comment. Fetched up front (rather than inside `loadProjectSubtreeRollups`
  // below) because it also resolves `includeSubProjects` into the WHERE
  // clause, which has to be built before this page's ids exist; it is then
  // handed back in so the tree is never queried twice.
  const tree = await loadProjectTree(db);
  const { childrenByParent, nameById } = tree;

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

  const [{ ownRollups, subtreeRollups }, deps] = await Promise.all([
    loadProjectSubtreeRollups(db, ids, tree),
    projectDependencyIds(db, ids),
  ]);

  const data = rows.map((row) =>
    dbProjectToAPI(
      row,
      ownRollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
      subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      row.parentProjectId ? (nameById.get(row.parentProjectId) ?? null) : null,
      childrenByParent.get(row.id) ?? [],
    ),
  );

  return { data, count };
};
