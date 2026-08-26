/**
 * `task.summary` — cheap counts for the /tasks summary strip, replacing a
 * full-history fetch. One recursive SQL statement computes all seven figures,
 * including the same manual/task/project-ancestor blocking semantics as
 * `listActionableTasks`, without hydrating task rows or why-chain display data.
 *
 * All top-level-only counts (`totalOpen`, `inbox`, `overdue`, `dueThisWeek`)
 * exclude subtasks (`parentTaskId IS NOT NULL`) — a checklist item is
 * represented via its parent everywhere else in this codebase (see
 * actionable.ts's doc comment), match that convention.
 */
import type { TaskSummaryOut } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import { openTaskBlockingCtes } from "./blocking-sql";

export async function getTaskSummary(db: Database): Promise<TaskSummaryOut> {
  const today = householdLocalDate();
  const weekOut = householdDaysFromNow(7);
  const result = await getDb(db).execute<{
    totalOpen: number;
    next: number;
    later: number;
    inbox: number;
    overdue: number;
    dueThisWeek: number;
    blocked: number;
  }>(sql`${openTaskBlockingCtes}
    SELECT
      COUNT(*)::int AS "totalOpen",
      COUNT(*) FILTER (
        WHERE bt."id" IS NULL AND t."status" IN ('not_started', 'in_progress')
      )::int AS "next",
      COUNT(*) FILTER (
        WHERE bt."id" IS NULL AND t."status" = 'later'
      )::int AS "later",
      COUNT(*) FILTER (WHERE t."projectId" IS NULL)::int AS "inbox",
      COUNT(*) FILTER (
        WHERE COALESCE(t."dueEndDate", t."dueDate") < ${today}
      )::int AS "overdue",
      COUNT(*) FILTER (
        WHERE COALESCE(t."dueEndDate", t."dueDate") >= ${today}
          AND COALESCE(t."dueEndDate", t."dueDate") <= ${weekOut}
      )::int AS "dueThisWeek",
      COUNT(*) FILTER (WHERE bt."id" IS NOT NULL)::int AS "blocked"
    FROM "Task" t
    LEFT JOIN blocked_tasks bt ON bt."id" = t."id"
    WHERE t."deletedAt" IS NULL
      AND t."status" <> 'done'
      AND t."parentTaskId" IS NULL
  `);
  const row = result.rows[0];
  return {
    totalOpen: Number(row?.totalOpen ?? 0),
    next: Number(row?.next ?? 0),
    later: Number(row?.later ?? 0),
    inbox: Number(row?.inbox ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueThisWeek: Number(row?.dueThisWeek ?? 0),
    blocked: Number(row?.blocked ?? 0),
  };
}
