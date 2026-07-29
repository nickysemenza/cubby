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
import { project, purchase, task } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import { projectContentDates, projectDependencyIds } from "./analytics";
import {
  dbProjectToAPI,
  EMPTY_PROJECT_DATE_WINDOW,
  EMPTY_PROJECT_OWN_ROLLUP,
  EMPTY_PROJECT_SUBTREE_ROLLUP,
} from "./helpers";
import {
  aggregateSubtreeDates,
  collectDescendantIds,
  loadProjectSubtreeRollups,
  loadProjectTree,
} from "./subtree";

/**
 * Lightweight `{id, name}` options for pickers/filter selects — no
 * rollup/dependency joins. Feeds `project.options` (see `useProjectOptions`),
 * which used to page through the full `list` (rollups + deps) at pageSize 500
 * just to get names.
 *
 * Two queries, not one: the dates it carries are the EFFECTIVE window, so it
 * pays for `projectContentDates` on top of the project scan. That cost buys
 * correct purchase→project suggestions (`rankProjectSuggestions` ranks by
 * "was this project running on that date?", and a stale hand-typed window is
 * exactly what made it miss); the fold itself is pure TS over rows already in
 * hand. Still nowhere near the `list` call it replaced.
 */
export const projectNameOptions = async (
  db: Database,
): Promise<ProjectOptionsOut[]> => {
  const [rows, contentDates] = await Promise.all([
    getDb(db)
      .select({
        id: project.id,
        name: project.name,
        parentProjectId: project.parentProjectId,
        startDate: project.startDate,
        endDate: project.endDate,
      })
      .from(project)
      .where(notDeleted(project))
      .orderBy(asc(project.name)),
    projectContentDates(db),
  ]);

  const windows = aggregateSubtreeDates(rows, contentDates);
  return rows.map((row) => {
    const window = windows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW;
    return {
      id: row.id,
      name: row.name,
      effectiveStart: window.effectiveStart,
      effectiveEnd: window.effectiveEnd,
    };
  });
};

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

  // `startDate` is an override that is usually null now that the window is
  // derived, so sorting on the raw column would sink most of the table into a
  // null bucket. Sort on the effective start instead: the override when set,
  // else the project's own earliest dated task/purchase.
  //
  // APPROXIMATION: non-recursive. A parent with no override and no own content
  // still sorts as null even when its children are dated — matching the true
  // recursive fold would need a recursive CTE, and at this scale (75 projects,
  // 15 of them children) it moves nothing. Everything *displayed* comes from
  // `dates.effectiveStart`, which is fully recursive; this only orders rows.
  const effectiveStartSort = sql`coalesce(
    ${project.startDate},
    (select min(${task.dueDate}) from ${task}
      where ${task.projectId} = ${project.id} and ${notDeleted(task)}),
    (select min(${purchase.date}) from ${purchase}
      where ${purchase.projectId} = ${project.id} and ${notDeleted(purchase)})
  )`;
  const orderByArray = buildOrderBy(
    project,
    sorts,
    [...projectSortableFields],
    {
      resolve: (s) =>
        s.orderBy === "startDate"
          ? [
              s.direction === "asc"
                ? sql`${effectiveStartSort} asc nulls last`
                : sql`${effectiveStartSort} desc nulls last`,
            ]
          : null,
    },
  );
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

  const [{ ownRollups, subtreeRollups, dateWindows }, deps] = await Promise.all(
    [loadProjectSubtreeRollups(db, ids, tree), projectDependencyIds(db, ids)],
  );

  const data = rows.map((row) =>
    dbProjectToAPI({
      row,
      ownRollup: ownRollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
      subtreeRollup: subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
      dates: dateWindows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW,
      blockedByIds: deps.blockedBy.get(row.id) ?? [],
      blockingIds: deps.blocking.get(row.id) ?? [],
      parentProjectName: row.parentProjectId
        ? (nameById.get(row.parentProjectId) ?? null)
        : null,
      childProjectIds: childrenByParent.get(row.id) ?? [],
    }),
  );

  return { data, count };
};
