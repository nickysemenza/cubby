/**
 * `task.summary` — cheap counts for the /tasks summary strip, replacing a
 * full-history fetch. Every count is a plain SQL `count(*)` (via
 * `countWhere`) except `next`/`later`/`blocked`, which reuse
 * `listActionableTasks`'s partitioning (its unblocked/blocked semantics —
 * manual status + task/project dependency graph walk — aren't cheaply
 * expressible as a standalone count query, and correctness matching the
 * Next/Later/Blocked views exactly matters more than shaving a few ms).
 *
 * All top-level-only counts (`totalOpen`, `inbox`, `overdue`, `dueThisWeek`)
 * exclude subtasks (`parentTaskId IS NOT NULL`) — a checklist item is
 * represented via its parent everywhere else in this codebase (see
 * actionable.ts's doc comment), match that convention.
 */
import type { TaskSummaryOut } from "@cubby/schemas/project";
import { and, gte, isNull, lt, lte, ne } from "drizzle-orm";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import { countWhere, notDeleted } from "~/server/repo/database-helpers";
import { listActionableTasks } from "./actionable";
import { effectiveTaskDueDateSql } from "./helpers";

const topLevelOpen = () =>
  and(notDeleted(task), ne(task.status, "done"), isNull(task.parentTaskId));

export async function getTaskSummary(db: Database): Promise<TaskSummaryOut> {
  const today = householdLocalDate();
  const weekOut = householdDaysFromNow(7);

  const [totalOpen, inbox, overdue, dueThisWeek, actionable] =
    await Promise.all([
      countWhere(db, task, topLevelOpen()),
      countWhere(db, task, and(topLevelOpen(), isNull(task.projectId))),
      countWhere(
        db,
        task,
        and(topLevelOpen(), lt(effectiveTaskDueDateSql(), today)),
      ),
      countWhere(
        db,
        task,
        and(
          topLevelOpen(),
          gte(effectiveTaskDueDateSql(), today),
          lte(effectiveTaskDueDateSql(), weekOut),
        ),
      ),
      listActionableTasks(db),
    ]);

  return {
    totalOpen,
    next: actionable.next.length,
    later: actionable.later.length,
    inbox,
    overdue,
    dueThisWeek,
    blocked: actionable.blocked.length,
  };
}
