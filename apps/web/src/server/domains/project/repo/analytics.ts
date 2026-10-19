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
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  actualExpenseSql,
  plannedExpenseSql,
} from "~/server/db/computed/expense-aggregate-sql";
import { getDb, notDeleted, uuidArrayParam } from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { dependencyIdsFor } from "~/server/generic/entity-links/repo/dependency-edges";

import {
  EMPTY_PROJECT_CONTENT_DATES,
  EMPTY_PROJECT_OWN_ROLLUP,
  maxPlainDate,
  minPlainDate,
  type ProjectContentDates,
  type ProjectOwnRollup,
} from "./helpers";

type ProjectExpenseStatsRow = {
  projectId: ProjectId | null;
  spent: number;
  actualSpent: number;
  committedSpent: number;
  credits: number;
  expenseCount: number;
  contentStart: string | null;
  contentEnd: string | null;
};

const projectExpenseStats = async (
  db: Database,
): Promise<ProjectExpenseStatsRow[]> =>
  getDb(db)
    .execute<ProjectExpenseStatsRow>(sql`
      SELECT allocation."projectId",
        (coalesce(sum(allocation."attributedCents"::bigint), 0) / 100.0)::double precision AS "spent",
        (coalesce(sum(allocation."attributedCents"::bigint) filter (where ${sql.raw(actualExpenseSql("e"))} and e."cost" >= 0), 0) / 100.0)::double precision AS "actualSpent",
        (coalesce(sum(allocation."attributedCents"::bigint) filter (where ${sql.raw(plannedExpenseSql("e"))}), 0) / 100.0)::double precision AS "committedSpent",
        (coalesce(sum(-allocation."attributedCents"::bigint) filter (where ${sql.raw(actualExpenseSql("e"))} and e."cost" < 0), 0) / 100.0)::double precision AS "credits",
        count(distinct allocation."expenseId")::int AS "expenseCount",
        min(e."date") AS "contentStart", max(e."date") AS "contentEnd"
      FROM (${expenseDerivedReadSql("projects")}) allocation
      JOIN "Expense" e ON e."id" = allocation."expenseId"
      GROUP BY allocation."projectId"
    `)
    .then((result) => result.rows);

const projectTaskRollupRows = (db: Database, projectIds: ProjectId[]) =>
  getDb(db)
    .select({
      projectId: effectiveFieldSql<ProjectId | null>(
        "task",
        "projectId",
        "Task",
      ),
      taskCount: sql<number>`count(*)::int`,
      doneTaskCount: sql<number>`count(*) filter (where ${task.status} = ${"done"})::int`,
    })
    .from(task)
    .where(
      and(
        sql`${effectiveFieldSql<ProjectId | null>("task", "projectId", "Task")} = ANY(${uuidArrayParam(projectIds)})`,
        notDeleted(task),
      ),
    )
    .groupBy(effectiveFieldSql<ProjectId | null>("task", "projectId", "Task"));

const mergeProjectOwnRollups = (
  projectIds: ProjectId[],
  expenseRows: ProjectExpenseStatsRow[],
  taskRows: Awaited<ReturnType<typeof projectTaskRollupRows>>,
): Map<ProjectId, ProjectOwnRollup> => {
  const out = new Map<ProjectId, ProjectOwnRollup>();
  for (const id of projectIds) out.set(id, { ...EMPTY_PROJECT_OWN_ROLLUP });
  const selected = new Set(projectIds);
  for (const row of expenseRows) {
    if (!row.projectId || !selected.has(row.projectId)) continue;
    const existing = out.get(row.projectId)!;
    out.set(row.projectId, {
      ...existing,
      spent: row.spent,
      actualSpent: row.actualSpent,
      committedSpent: row.committedSpent,
      credits: row.credits,
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
};

const projectTaskDateRows = (db: Database, projectIds?: ProjectId[]) => {
  const projectId = effectiveFieldSql<ProjectId | null>("task", "projectId");
  return getDb(db)
    .select({
      projectId,
      contentStart: sql<string | null>`min(${task.dueDate})`,
      contentEnd: sql<string | null>`max(${effectiveTaskDueDateSql()})`,
    })
    .from(task)
    .where(
      and(
        projectIds ? inArray(projectId, projectIds) : isNotNull(projectId),
        notDeleted(task),
      ),
    )
    .groupBy(projectId);
};

const mergeProjectContentDates = (
  taskRows: Awaited<ReturnType<typeof projectTaskDateRows>>,
  expenseRows: Array<{
    projectId: ProjectId | null;
    contentStart: string | null;
    contentEnd: string | null;
  }>,
): Map<ProjectId, ProjectContentDates> => {
  const out = new Map<ProjectId, ProjectContentDates>();
  for (const row of [...taskRows, ...expenseRows]) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? EMPTY_PROJECT_CONTENT_DATES;
    out.set(row.projectId, {
      contentStart: minPlainDate(existing.contentStart, row.contentStart),
      contentEnd: maxPlainDate(existing.contentEnd, row.contentEnd),
    });
  }
  return out;
};

/**
 * Share one allocation pass when a subtree reader needs money and dates.
 * `spent` includes future expenses, matching the project's own rollup contract.
 */
export async function projectRollupsAndContentDates(
  db: Database,
  rollupIds: ProjectId[],
): Promise<{
  ownRollups: Map<ProjectId, ProjectOwnRollup>;
  contentDates: Map<ProjectId, ProjectContentDates>;
}> {
  const [expenseRows, taskRows, taskDateRows] = await Promise.all([
    projectExpenseStats(db),
    rollupIds.length > 0
      ? projectTaskRollupRows(db, rollupIds)
      : Promise.resolve([]),
    projectTaskDateRows(db),
  ]);
  return {
    ownRollups: mergeProjectOwnRollups(rollupIds, expenseRows, taskRows),
    contentDates: mergeProjectContentDates(taskDateRows, expenseRows),
  };
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
): Promise<Map<ProjectId, ProjectContentDates>> {
  const out = new Map<ProjectId, ProjectContentDates>();
  if (projectIds?.length === 0) return out;

  const scope = (column: SQL) =>
    projectIds ? inArray(column, projectIds) : isNotNull(column);

  const [taskRows, expenseRows] = await Promise.all([
    projectTaskDateRows(db, projectIds),
    getDb(db)
      .execute<{
        projectId: ProjectId;
        contentStart: string | null;
        contentEnd: string | null;
      }>(sql`
      SELECT allocation."projectId",
        min(e."date") AS "contentStart", max(e."date") AS "contentEnd"
      FROM (${expenseDerivedReadSql("projects")}) allocation
      JOIN "Expense" e ON e."id" = allocation."expenseId"
      WHERE ${scope(sql`allocation."projectId"`)}
      GROUP BY allocation."projectId"
    `)
      .then((result) => result.rows),
  ]);

  return mergeProjectContentDates(taskRows, expenseRows);
}

/**
 * Every live project's content dates with one Expense left out, for each
 * excluded Expense. One allocation pass serves the whole set; removing a line
 * never re-weights its siblings, so each exclusion only drops that line's own
 * dated shares.
 */
export async function projectContentDatesExcluding(
  db: Database,
  excludeExpenseIds: readonly ExpenseId[],
): Promise<Map<ExpenseId, Map<ProjectId, ProjectContentDates>>> {
  const excluded = uniq(excludeExpenseIds);
  if (excluded.length === 0) return new Map();
  const [taskRows, expenseRows] = await Promise.all([
    projectTaskDateRows(db),
    getDb(db)
      .execute<{
        excludedId: ExpenseId;
        projectId: ProjectId;
        contentStart: string | null;
        contentEnd: string | null;
      }>(sql`
      WITH allocation AS MATERIALIZED (${expenseDerivedReadSql("projects")})
      SELECT excluded.id AS "excludedId", allocation."projectId",
        min(e."date") AS "contentStart", max(e."date") AS "contentEnd"
      FROM allocation
      JOIN "Expense" e ON e."id" = allocation."expenseId"
      CROSS JOIN unnest(${uuidArrayParam(excluded)}) AS excluded(id)
      WHERE allocation."projectId" IS NOT NULL AND e."id" <> excluded.id
      GROUP BY excluded.id, allocation."projectId"
    `)
      .then((result) => result.rows),
  ]);
  return new Map(
    excluded.map((id) => [
      id,
      mergeProjectContentDates(
        taskRows,
        // Postgres renders uuids lowercase; the map keeps the caller's spelling.
        expenseRows.filter((row) => row.excludedId === id.toLowerCase()),
      ),
    ]),
  );
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
  return dependencyIdsFor(db, "project", projectIds);
}
