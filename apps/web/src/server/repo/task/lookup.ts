import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type PresenceFilter,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { taskSortableFields } from "@cubby/schemas/project";
import {
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  getDb,
  presenceCondition,
  relations,
} from "~/server/repo/database-helpers";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI, effectiveTaskDueDateSql } from "./helpers";

/**
 * The `task.projectId` WHERE condition for a `projectId` + `includeSubProjects`
 * filter pair: a plain equality match, or — when `includeSubProjects` is set —
 * an `inArray` over the project plus every live descendant (walking
 * `parentProjectId` down via project/subtree.ts's shared helpers). Shared by
 * `taskList` and `getTaskBoard` so the subtree-expansion logic lives in one
 * place.
 *
 * `presence` is the header filter's `(none)` / `Has project` sentinel, OR-ed
 * with the selection rather than ANDed against it: `{projectId: [A],
 * presence: "none"}` means "project A **or** unassigned". That's why it can't
 * just be a separate condition in the caller's list — an AND there is the bug
 * this replaced. `undefined` when neither is given (no condition added).
 */
export async function buildTaskProjectCondition(
  db: Database,
  projectId: ProjectId | ProjectId[] | undefined,
  includeSubProjects: boolean | undefined,
  presence?: PresenceFilter,
): Promise<SQL | undefined> {
  const presenceCond = presenceCondition(task.projectId, presence);
  const selected = projectId ? [projectId].flat() : [];
  if (selected.length === 0) return presenceCond;
  if (!includeSubProjects)
    return or(eqAny(task.projectId, projectId), presenceCond);

  const { childrenByParent } = await loadProjectTree(db);
  return or(
    inArray(
      task.projectId,
      uniq(
        selected.flatMap((id) => [
          id,
          ...collectDescendantIds(childrenByParent, id),
        ]),
      ),
    ),
    presenceCond,
  );
}

/**
 * The joined project name isn't a column on `task` — a correlated subquery
 * keeps `taskList` a relational `findMany`. Soft-delete guarded and NULLS LAST
 * in both directions, matching `buildOrderBy`'s convention.
 */
const resolveTaskSort = (sort: SortParams) => {
  if (sort.orderBy !== "project") return null;
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";
  return [
    sql.raw(
      `(SELECT p."name" FROM "Project" p ` +
        `WHERE p."id" = "task"."projectId" AND p."deletedAt" IS NULL) ${dirSql}`,
    ),
  ];
};

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
    filters.projectPresenceFilter,
  );

  const whereClause = buildSearchConditions(
    task,
    [{ column: task.name, term: filters.search }],
    [
      eqAny(task.status, filters.status),
      // Carries `projectPresenceFilter` too — it ORs with the id selection, so
      // it can't be a sibling condition here (that AND is what made
      // "project A or unassigned" inexpressible).
      projectCondition,
      eqAny(task.trade, filters.trade),
      filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
      filters.parentTaskId
        ? eq(task.parentTaskId, filters.parentTaskId)
        : undefined,
      // Filter on the EFFECTIVE due date — `dueEndDate ?? dueDate` — so a
      // ranged task still inside its window isn't treated as overdue, matching
      // the "overdue" semantics used on the board/stat tiles.
      //
      // A task with BOTH due columns null falls out of any window by plain SQL
      // comparison semantics — `coalesce(NULL, NULL) >= x` is NULL, not true —
      // that's intended, not a bug to work around (the identical rule is
      // documented for `expense.date` in `expense/lookup.ts`'s
      // `buildExpenseWhereClause`). The dashboard surfaces the count of rows
      // hidden this way as `hiddenByDate.tasks`.
      filters.dueFrom
        ? gte(effectiveTaskDueDateSql(), filters.dueFrom)
        : undefined,
      filters.dueTo ? lte(effectiveTaskDueDateSql(), filters.dueTo) : undefined,
      // Completion scope: undefined/"all" adds no condition (today's default,
      // unchanged) — see taskCompletionSchema.
      filters.completion === "open"
        ? ne(task.status, "done")
        : filters.completion === "done"
          ? eq(task.status, "done")
          : undefined,
    ],
  );

  const orderByArray = buildOrderBy(task, sorts, [...taskSortableFields], {
    resolve: resolveTaskSort,
  });
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
