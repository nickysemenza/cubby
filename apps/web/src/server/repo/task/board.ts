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
import type { TaskBoardInput, TaskBoardOut } from "@cubby/schemas/project";

import type { Database } from "~/server/db";

import { taskList } from "./lookup";

/** Body cap for `recentDone` — mirrors board-model.ts's `DONE_COLUMN_CAP`. */
const RECENT_DONE_CAP = 20;

export async function getTaskBoard(
  db: Database,
  input: TaskBoardInput,
): Promise<TaskBoardOut> {
  const intrinsic = { ...input, topLevelOnly: true };
  const [activeResult, doneResult] = await Promise.all([
    taskList(
      db,
      { ...intrinsic, completion: "open" },
      [{ orderBy: "createdAt", direction: "desc" }],
      { pageIndex: 0, pageSize: 100_000 },
    ),
    taskList(
      db,
      { ...intrinsic, completion: "done" },
      [{ orderBy: "updatedAt", direction: "desc" }],
      { pageIndex: 0, pageSize: RECENT_DONE_CAP },
    ),
  ]);

  return {
    active: activeResult.data,
    recentDone: doneResult.data,
    doneCount: doneResult.count,
  };
}
