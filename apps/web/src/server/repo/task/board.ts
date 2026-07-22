/**
 * `task.board` — the board's data source, replacing the old
 * `task.chartData({topLevelOnly: true})` fetch-everything-then-cap-client-side
 * pattern. Splits into `active` (every live, top-level, non-done task
 * matching the filters — the board computes its own columns/lanes/cell
 * ordering from this, see `board-model.ts`) and `recentDone` (the same
 * filters, `status = 'done'`, capped to the 20 most recently updated — the
 * exact selection `board-model.ts`'s `cellTasks` used to do client-side for
 * the status-mode Done column, see `DONE_COLUMN_CAP`), plus `doneCount` — the
 * TRUE total of matching done tasks, not just the capped 20, for the
 * column/History-affordance header count.
 */
import type {
  TaskBoardInput,
  TaskBoardOut,
  TaskOut,
} from "@cubby/schemas/project";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import {
  buildSearchConditions,
  countWhere,
  getDb,
  relations,
} from "~/server/repo/database-helpers";
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI } from "./helpers";
import { buildTaskProjectCondition } from "./lookup";

/** Body cap for `recentDone` — mirrors board-model.ts's `DONE_COLUMN_CAP`. */
const RECENT_DONE_CAP = 20;

async function rowsToTaskOut(
  db: Database,
  rows: Array<Parameters<typeof dbTaskToAPI>[0]>,
): Promise<TaskOut[]> {
  const ids = rows.map((r) => r.id);
  const [deps, subtaskCounts] = await Promise.all([
    taskDependencyIds(db, ids),
    taskSubtaskCounts(db, ids),
  ]);
  return rows.map((row) => {
    const counts = subtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  });
}

export async function getTaskBoard(
  db: Database,
  input: TaskBoardInput,
): Promise<TaskBoardOut> {
  const projectCondition = await buildTaskProjectCondition(
    db,
    input.projectId,
    input.includeSubProjects,
  );

  const baseWhere = buildSearchConditions(
    task,
    [{ column: task.name, term: input.search }],
    [isNull(task.parentTaskId), projectCondition],
  );

  const activeWhere = and(baseWhere, ne(task.status, "done"));
  const doneWhere = and(baseWhere, eq(task.status, "done"));

  const [activeRows, doneRows, doneCount] = await Promise.all([
    getDb(db).query.task.findMany({
      where: activeWhere,
      orderBy: desc(task.createdAt),
      ...relations.task.withProject,
    }),
    getDb(db).query.task.findMany({
      where: doneWhere,
      orderBy: desc(task.updatedAt),
      limit: RECENT_DONE_CAP,
      ...relations.task.withProject,
    }),
    countWhere(db, task, doneWhere),
  ]);

  const [active, recentDone] = await Promise.all([
    rowsToTaskOut(db, activeRows),
    rowsToTaskOut(db, doneRows),
  ]);

  return { active, recentDone, doneCount };
}
