/**
 * Project analytics: batched cost/progress rollups and dependency-edge reads.
 *
 * Both `projectRollups` and `projectDependencyIds` take a *set* of project ids
 * and return a lookup keyed by id — one query per underlying relation (two for
 * the rollup: expenses + tasks; two for dependencies: blocked-by + blocking),
 * never one query per project. Callers (crud.ts's reader, lookup.ts's list)
 * always batch the ids of the page/row they're mapping, so a list of 50
 * projects costs 4 queries total, not 200.
 */
import type { ExpenseId, ProjectId } from "@cubby/schemas/identifiers";
import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { projectDependency, task } from "~/server/db/schema";
import {
  dependencyIdsFor,
  getDb,
  notDeleted,
  uuidArrayParam,
} from "~/server/repo/database-helpers";
import { expenseProjectAllocationSql } from "~/server/repo/expense-project-allocation";
import { effectiveTaskProjectSql } from "~/server/repo/task-project-inheritance";
import { effectiveTaskDueDateSql } from "~/server/repo/task/helpers";

import {
  EMPTY_PROJECT_CONTENT_DATES,
  EMPTY_PROJECT_OWN_ROLLUP,
  maxPlainDate,
  minPlainDate,
  type ProjectContentDates,
  type ProjectOwnRollup,
} from "./helpers";

/**
 * SUM/COUNT rollups over live expenses and tasks, per project — this
 * project's OWN aggregate only (never recursive; see repo/project/subtree.ts
 * for the subtree total built on top of this).
 *
 * `spent` sums ALL live expenses including `future` (not-yet-made) ones —
 * this matches the retired Notion rollup's semantics (a planned spend still
 * counts toward the running total against the estimate). See
 * packages/schemas/src/project.ts's `projectRollup` doc comment.
 */
export async function projectRollups(
  db: Database,
  projectIds: ProjectId[],
): Promise<Map<ProjectId, ProjectOwnRollup>> {
  const out = new Map<ProjectId, ProjectOwnRollup>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, { ...EMPTY_PROJECT_OWN_ROLLUP });

  const [expenseRows, taskRows] = await Promise.all([
    getDb(db)
      .execute<{
        projectId: ProjectId | null;
        spent: number;
        actualSpent: number;
        committedSpent: number;
        contributions: number;
        expenseCount: number;
      }>(sql`
      SELECT allocation."projectId",
        (coalesce(sum(allocation."attributedCents"::bigint), 0) / 100.0)::double precision AS "spent",
        (coalesce(sum(allocation."attributedCents"::bigint) filter (where e."future" = false and e."cost" >= 0), 0) / 100.0)::double precision AS "actualSpent",
        (coalesce(sum(allocation."attributedCents"::bigint) filter (where e."future" = true), 0) / 100.0)::double precision AS "committedSpent",
        (coalesce(sum(-allocation."attributedCents"::bigint) filter (where e."future" = false and e."cost" < 0), 0) / 100.0)::double precision AS "contributions",
        count(distinct allocation."expenseId")::int AS "expenseCount"
      FROM (${expenseProjectAllocationSql()}) allocation
      JOIN "Expense" e ON e."id" = allocation."expenseId"
      WHERE allocation."projectId" = ANY(${uuidArrayParam(projectIds)})
      GROUP BY allocation."projectId"
    `)
      .then((result) => result.rows),
    getDb(db)
      .select({
        projectId: effectiveTaskProjectSql("Task"),
        taskCount: sql<number>`count(*)::int`,
        doneTaskCount: sql<number>`count(*) filter (where ${task.status} = ${"done"})::int`,
      })
      .from(task)
      .where(
        and(
          sql`${effectiveTaskProjectSql("Task")} = ANY(${uuidArrayParam(projectIds)})`,
          notDeleted(task),
        ),
      )
      .groupBy(effectiveTaskProjectSql("Task")),
  ]);

  for (const row of expenseRows) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? { ...EMPTY_PROJECT_OWN_ROLLUP };
    out.set(row.projectId, {
      ...existing,
      spent: row.spent,
      actualSpent: row.actualSpent,
      committedSpent: row.committedSpent,
      contributions: row.contributions,
      expenseCount: row.expenseCount,
    });
  }
  for (const row of taskRows) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? { ...EMPTY_PROJECT_OWN_ROLLUP };
    out.set(row.projectId, {
      ...existing,
      taskCount: row.taskCount,
      doneTaskCount: row.doneTaskCount,
    });
  }
  return out;
}

/**
 * Each project's OWN dated-content bounds — `min`/`max` over its live tasks
 * (`dueDate` … `coalesce(dueEndDate, dueDate)`, since a task with no
 * `dueEndDate` is a one-day task) and its live expenses (`date`). This is the
 * leaf input to subtree.ts's `aggregateSubtreeDates`, which folds it up the
 * WBS tree into each project's derived window.
 *
 * Two grouped queries in parallel, merged in TS — the same batching discipline
 * as `projectRollups`, never one query per project. It lives here as its own
 * function rather than riding along inside `projectRollups` because the picker
 * path (`projectNameOptions`) wants dates *without* the money aggregate, and
 * restating the one-day-task rule at a second call site is how it would drift.
 *
 * Negative expenses (refunds and price adjustments) count: they are dated
 * project activity, and the tracker has no other place that filters them out
 * of a date range.
 *
 * `projectIds` scopes the scan; omit it for every live project.
 */
export async function projectContentDates(
  db: Database,
  projectIds?: ProjectId[],
  excludeExpenseId?: ExpenseId,
): Promise<Map<ProjectId, ProjectContentDates>> {
  const out = new Map<ProjectId, ProjectContentDates>();
  if (projectIds?.length === 0) return out;

  const scope = (column: SQL) =>
    projectIds ? inArray(column, projectIds) : isNotNull(column);

  const [taskRows, expenseRows] = await Promise.all([
    getDb(db)
      .select({
        projectId: effectiveTaskProjectSql(),
        contentStart: sql<string | null>`min(${task.dueDate})`,
        contentEnd: sql<string | null>`max(${effectiveTaskDueDateSql()})`,
      })
      .from(task)
      .where(and(scope(effectiveTaskProjectSql()), notDeleted(task)))
      .groupBy(effectiveTaskProjectSql()),
    getDb(db)
      .execute<{
        projectId: ProjectId;
        contentStart: string | null;
        contentEnd: string | null;
      }>(sql`
      SELECT allocation."projectId",
        min(e."date") AS "contentStart", max(e."date") AS "contentEnd"
      FROM (${expenseProjectAllocationSql()}) allocation
      JOIN "Expense" e ON e."id" = allocation."expenseId"
      WHERE ${scope(sql`allocation."projectId"`)}
        ${excludeExpenseId ? sql`AND e."id" <> ${excludeExpenseId}` : sql``}
      GROUP BY allocation."projectId"
    `)
      .then((result) => result.rows),
  ]);

  for (const row of [...taskRows, ...expenseRows]) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? EMPTY_PROJECT_CONTENT_DATES;
    out.set(row.projectId, {
      contentStart: minPlainDate(existing.contentStart, row.contentStart),
      contentEnd: maxPlainDate(existing.contentEnd, row.contentEnd),
    });
  }
  return out;
}

/**
 * Blocked-by / blocking id arrays for a set of projects. `projectDependency`
 * rows are directed edges (projectId is blocked by blockedByProjectId);
 * "blocking" is the reverse read of the same table — which projects does THIS
 * project block. Thin wrapper over the generic `dependencyIdsFor` (mirrored by
 * task/crud.ts's `taskDependencyIds`) — kept as a named export since it's
 * consumed by name elsewhere (crud.ts's reader).
 */
export async function projectDependencyIds(
  db: Database,
  projectIds: ProjectId[],
): Promise<{
  blockedBy: Map<ProjectId, ProjectId[]>;
  blocking: Map<ProjectId, ProjectId[]>;
}> {
  return dependencyIdsFor(
    db,
    {
      ownColumn: projectDependency.projectId,
      blockedByColumn: projectDependency.blockedByProjectId,
      entity: "project",
    },
    projectIds,
  );
}
