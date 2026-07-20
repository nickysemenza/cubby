import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { taskSortableFields } from "@cubby/schemas/project";
import { eq, isNull } from "drizzle-orm";
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
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI } from "./helpers";

export const taskList = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: TaskOut[]; count: number }> => {
  const whereClause = buildSearchConditions(
    task,
    [{ column: task.name, term: filters.search }],
    [
      filters.status ? eq(task.status, filters.status) : undefined,
      filters.projectId ? eq(task.projectId, filters.projectId) : undefined,
      filters.trade ? eq(task.trade, filters.trade) : undefined,
      filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
      filters.parentTaskId
        ? eq(task.parentTaskId, filters.parentTaskId)
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
