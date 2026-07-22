import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { taskSortableFields } from "@cubby/schemas/project";
import { eq, gte, inArray, isNull, lte, ne, type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  relations,
} from "~/server/repo/database-helpers";
import {
  allProjectParentRows,
  buildChildrenMap,
  collectDescendantIds,
} from "~/server/repo/project/subtree";
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI } from "./helpers";

/**
 * The `task.projectId` WHERE condition for a `projectId` + `includeSubProjects`
 * filter pair: a plain equality match, or — when `includeSubProjects` is set —
 * an `inArray` over the project plus every live descendant (walking
 * `parentProjectId` down via project/subtree.ts's shared helpers). `undefined`
 * when no `projectId` filter is given (no condition added). Shared by
 * `taskList` and `getTaskBoard` so the subtree-expansion logic lives in one
 * place.
 */
export async function buildTaskProjectCondition(
  db: Database,
  projectId: ProjectId | undefined,
  includeSubProjects: boolean | undefined,
): Promise<SQL | undefined> {
  if (!projectId) return undefined;
  if (!includeSubProjects) return eq(task.projectId, projectId);

  const parentRows = await allProjectParentRows(db);
  const descendantIds = collectDescendantIds(
    buildChildrenMap(parentRows),
    projectId,
  );
  return inArray(task.projectId, [projectId, ...descendantIds]);
}

export const taskList = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: TaskOut[]; count: number }> => {
  const projectCondition = await buildTaskProjectCondition(
    db,
    filters.projectId,
    filters.includeSubProjects,
  );

  const whereClause = buildSearchConditions(
    task,
    [{ column: task.name, term: filters.search }],
    [
      filters.status ? eq(task.status, filters.status) : undefined,
      projectCondition,
      filters.noProject ? isNull(task.projectId) : undefined,
      filters.trade ? eq(task.trade, filters.trade) : undefined,
      filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
      filters.parentTaskId
        ? eq(task.parentTaskId, filters.parentTaskId)
        : undefined,
      // Filter on the EFFECTIVE due date — `dueEndDate ?? dueDate` — so a
      // ranged task still inside its window isn't treated as overdue, matching
      // the "overdue" semantics used on the board/stat tiles.
      filters.dueFrom
        ? gte(
            sql`coalesce(${task.dueEndDate}, ${task.dueDate})`,
            filters.dueFrom,
          )
        : undefined,
      filters.dueTo
        ? lte(sql`coalesce(${task.dueEndDate}, ${task.dueDate})`, filters.dueTo)
        : undefined,
      // Completion scope: undefined/"all" adds no condition (today's default,
      // unchanged) — see taskCompletionSchema.
      filters.completion === "open"
        ? ne(task.status, "done")
        : filters.completion === "done"
          ? eq(task.status, "done")
          : undefined,
    ],
  );

  const orderByArray = buildOrderBy(task, sorts, [...taskSortableFields]);
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.task.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.task.withProject,
    }),
    countWhere(db, task, whereClause),
  );

  const ids = rows.map((r) => r.id);
  const [deps, subtaskCounts] = await Promise.all([
    taskDependencyIds(db, ids),
    taskSubtaskCounts(db, ids),
  ]);

  const data = rows.map((row) => {
    const counts = subtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  });

  return { data, count };
};
