import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { taskSortableFields } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
} from "~/server/repo/database-helpers";
import { taskDependencyIds } from "./crud";
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
      filters.category ? eq(task.category, filters.category) : undefined,
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
      with: { project: { columns: { name: true, deletedAt: true } } },
    }),
    countWhere(db, task, whereClause),
  );

  const ids = rows.map((r) => r.id);
  const deps = await taskDependencyIds(db, ids);

  const data = rows.map((row) =>
    dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
    ),
  );

  return { data, count };
};
