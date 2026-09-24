/**
 * The bounded work projection for Today's first decision. It shares the
 * recursive blocked-task CTE used by `task.summary`, but only returns the
 * four highest-priority ready tasks rather than hydrating the entire
 * actionable graph (including relationship and why-chain display fields).
 */

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { TaskTodayBriefingOut } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";

import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

import { openTaskBlockingCtes } from "./blocking-sql";

type BriefingRow = {
  nextCount: number;
  laterCount: number;
  blockedCount: number;
  overdueCount: number;
  dueThisWeekCount: number;
  rank: number | null;
  id: string | null;
  name: string | null;
  status: "not_started" | "in_progress" | null;
  dueDate: string | null;
  dueEndDate: string | null;
  projectId: string | null;
  projectName: string | null;
  projectIcon: string | null;
};

export async function getTaskTodayBriefing(
  db: Database,
): Promise<TaskTodayBriefingOut> {
  const today = householdLocalDate();
  const weekOut = householdDaysFromNow(7);
  const result = await getDb(db).execute<BriefingRow>(sql`
    ${openTaskBlockingCtes}, briefing_tasks AS (
      SELECT
        t."shortcode" AS "id",
        t."name",
        t."status",
        t."dueDate",
        t."dueEndDate",
        live_project."shortcode" AS "projectId",
        live_project."name" AS "projectName",
        live_project."icon" AS "projectIcon",
        bt."id" IS NOT NULL AS "isBlocked"
      FROM "Task" t
      LEFT JOIN blocked_tasks bt ON bt."id" = t."id"
      LEFT JOIN "Project" live_project
        ON live_project."id" = t."projectId"
       AND live_project."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL
        AND t."status" <> 'done'
        AND t."parentTaskId" IS NULL
    ), summary AS (
      SELECT
        COUNT(*) FILTER (
          WHERE NOT "isBlocked" AND "status" IN ('not_started', 'in_progress')
        )::int AS "nextCount",
        COUNT(*) FILTER (
          WHERE NOT "isBlocked" AND "status" = 'later'
        )::int AS "laterCount",
        COUNT(*) FILTER (WHERE "isBlocked")::int AS "blockedCount",
        COUNT(*) FILTER (
          WHERE COALESCE("dueEndDate", "dueDate") < ${today}
        )::int AS "overdueCount",
        COUNT(*) FILTER (
          WHERE COALESCE("dueEndDate", "dueDate") >= ${today}
            AND COALESCE("dueEndDate", "dueDate") <= ${weekOut}
        )::int AS "dueThisWeekCount"
      FROM briefing_tasks
    ), ranked_next AS (
      SELECT
        "id", "name", "status", "dueDate", "dueEndDate", "projectId", "projectName", "projectIcon",
        ROW_NUMBER() OVER (
          ORDER BY
            CASE
              WHEN COALESCE("dueEndDate", "dueDate") < ${today} THEN 0
              ELSE 1
            END,
            COALESCE("dueEndDate", "dueDate") ASC NULLS LAST,
            CASE WHEN "status" = 'in_progress' THEN 0 ELSE 1 END,
            "name" ASC
        ) AS "rank"
      FROM briefing_tasks
      WHERE NOT "isBlocked"
        AND "status" IN ('not_started', 'in_progress')
    )
    SELECT
      summary."nextCount",
      summary."laterCount",
      summary."blockedCount",
      summary."overdueCount",
      summary."dueThisWeekCount",
      ranked_next."rank",
      ranked_next."id",
      ranked_next."name",
      ranked_next."status",
      ranked_next."dueDate",
      ranked_next."dueEndDate",
      ranked_next."projectId",
      ranked_next."projectName",
      ranked_next."projectIcon"
    FROM summary
    LEFT JOIN ranked_next ON ranked_next."rank" <= 4
    ORDER BY ranked_next."rank" ASC NULLS LAST
  `);

  const first = result.rows[0];
  return {
    next: result.rows.flatMap((row) =>
      row.id && row.name && row.status
        ? [
            {
              id: parseShortcodeFor("task", row.id),
              name: row.name,
              status: row.status,
              dueDate: row.dueDate,
              dueEndDate: row.dueEndDate,
              projectId: row.projectId
                ? parseShortcodeFor("project", row.projectId)
                : null,
              projectName: row.projectName,
              projectIcon: row.projectIcon,
            },
          ]
        : [],
    ),
    nextCount: Number(first?.nextCount ?? 0),
    laterCount: Number(first?.laterCount ?? 0),
    blockedCount: Number(first?.blockedCount ?? 0),
    overdueCount: Number(first?.overdueCount ?? 0),
    dueThisWeekCount: Number(first?.dueThisWeekCount ?? 0),
  };
}
