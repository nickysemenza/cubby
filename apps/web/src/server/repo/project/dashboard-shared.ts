/**
 * Two honesty rules the dashboard UI depends on:
 *   - an empty/omitted `statusScope` adds NO status condition (all four
 *     statuses). It used to silently fall back to `!= 'done'`, which nothing
 *     in the chip bar said — callers that want the live-only default now pass
 *     `LIVE_PROJECT_STATUSES` explicitly (see the MCP `get_house_status`
 *     tool and the Overview default);
 *   - a date window filters the PROJECT set too (interval overlap), not just
 *     the expense/task aggregates hanging off it — and since `startDate`/
 *     `endDate` are now manual OVERRIDES on a derived window, that overlap
 *     tests the project's dated CONTENT as well, not only the two columns.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  EmbeddedProjectScope,
  ProjectDashboardFilters,
} from "@cubby/schemas/project";
import {
  and,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { project, task } from "~/server/db/schema";
import {
  buildSearchConditions,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import { expenseProjectAllocationSql } from "~/server/repo/expense-project-allocation";
import {
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
} from "~/server/repo/task-project-inheritance";
import { effectiveTaskDueDateSql } from "~/server/repo/task/helpers";

import { loadProjectDateWindows, projectCompletionYear } from "./subtree";

export function dashboardKindLocationConditions(
  filters: Pick<ProjectDashboardFilters, "kinds" | "locations">,
): Array<SQL | undefined> {
  return [
    filters.kinds && filters.kinds.length > 0
      ? inArray(project.kind, filters.kinds)
      : undefined,
    // `locations` is a free-form text[] column — array-overlap membership
    // (project matches if ANY of its locations is in the filter set), the
    // other direction of the singular `location` filter in
    // project/lookup.ts (`= ANY(...)`).
    //
    // SQL-valued inherited arrays need an explicit PostgreSQL text[] operand;
    // passing a JS array to a raw expression becomes a row constructor.
    filters.locations && filters.locations.length > 0
      ? sql`${effectiveProjectLocationsSql(sql`${project.id}`)} && ARRAY[${sql.join(
          filters.locations.map((value) => sql`${value}`),
          sql`, `,
        )}]::text[]`
      : undefined,
  ];
}

function dashboardStatusCondition(
  filters: Pick<ProjectDashboardFilters, "statusScope">,
): SQL | undefined {
  return filters.statusScope && filters.statusScope.length > 0
    ? inArray(project.status, filters.statusScope)
    : undefined;
}

const qb = new QueryBuilder();

/**
 * Project ids owning at least one live, DATED task — optionally clipped to
 * `[dateFrom, dateTo]`.
 *
 * A task spans `dueDate` … `coalesce(dueEndDate, dueDate)`, since a task with
 * no `dueEndDate` is a one-day task. That is the same rule `projectContentDates`
 * (analytics.ts) folds into the derived window and the same one task/lookup.ts
 * filters due windows on — restating it at yet another call site is how it
 * would drift, so if you touch one, touch all three.
 *
 * Three things this sub-select owns, none of which SQL will warn about:
 *  - **UNCORRELATED on purpose.** It never references `project.id`; the caller
 *    applies it with `inArray`/`notInArray` at the WHERE's top level. A
 *    correlated `EXISTS` is broken here: `buildDashboardProjectWhere` is fed to
 *    drizzle's relational query builder (`query.project.findMany`), which
 *    aliases the root table to `"project"` but does NOT rewrite column
 *    references buried inside a sub-select — the correlation would emit
 *    `"Project"."id"` against a FROM entry that no longer exists — while
 *    `buildUndatedProjectWhere` is fed to an unaliased `countWhere`. Same trap,
 *    same fix, as the product list's presence filters (see `idSetPresence` in
 *    database-helpers/query.ts).
 *  - **Soft deletes.** `notDeleted(task)` is load-bearing: a project whose
 *    tasks were all soft-deleted must NOT read as dated. `pnpm check`'s
 *    `cubby/require-soft-delete-filter` oxlint rule only scans
 *    `exists()`/`notExists()` bodies, so it cannot see this one — it is on
 *    review to keep it here.
 *  - **Nullable FK.** `task.projectId` is nullable and a NULL inside a
 *    `NOT IN` list makes the whole predicate UNKNOWN, so without
 *    `isNotNull(effectiveTaskProjectSql())` `buildUndatedProjectWhere` would count zero
 *    rows instead of the genuinely undated ones.
 */
function datedTaskProjectIds(dateFrom?: string, dateTo?: string) {
  return qb
    .select({ projectId: effectiveTaskProjectSql() })
    .from(task)
    .where(
      and(
        notDeleted(task),
        isNotNull(effectiveTaskProjectSql()),
        isNotNull(task.dueDate),
        dateTo ? lte(task.dueDate, dateTo) : undefined,
        dateFrom ? gte(effectiveTaskDueDateSql(), dateFrom) : undefined,
      ),
    );
}

/**
 * Project ids owning at least one live, dated expense — the expense half of
 * {@link datedTaskProjectIds}, and uncorrelated / `notDeleted` / `isNotNull`
 * for the same three reasons documented there.
 *
 * Negative expenses (refunds and price adjustments) count, matching
 * `projectContentDates`: they are dated project activity, and nowhere else in
 * the tracker filters them out of a date range.
 */
function datedExpenseProjectIds(dateFrom?: string, dateTo?: string) {
  return sql`(SELECT DISTINCT allocation."projectId"
    FROM (${expenseProjectAllocationSql()}) allocation
    JOIN "Expense" dated_expense ON dated_expense."id" = allocation."expenseId"
    WHERE allocation."projectId" IS NOT NULL
      AND dated_expense."date" IS NOT NULL
      ${dateTo ? sql`AND dated_expense."date" <= ${dateTo}` : sql``}
      ${dateFrom ? sql`AND dated_expense."date" >= ${dateFrom}` : sql``})`;
}

/**
 * Date-window condition for the dashboard scope: a project matches when its
 * EXPLICIT `[startDate, endDate]` interval overlaps `[dateFrom, dateTo]`, OR
 * when it owns dated content (a task or an expense) inside that window.
 * `undefined` when neither bound is set.
 *
 *   (   (start IS NULL OR start <= dateTo)
 *   AND (end   IS NULL OR end   >= dateFrom)
 *   AND (start IS NOT NULL OR end IS NOT NULL) )
 *   OR id IN (live tasks overlapping the window)
 *   OR id IN (live expenses inside the window)
 *
 * The OR is the whole point now that `startDate`/`endDate` are manual
 * OVERRIDES on a DERIVED window (see subtree.ts's `aggregateSubtreeDates`):
 * most projects leave both null, so the explicit branch alone would drop a
 * project whose tasks and expenses sit squarely inside the chosen window. It
 * cuts the other way too — a project carrying a stale, too-narrow override
 * still matches on the activity that outgrew it.
 *
 * A null side of the explicit interval is still read as open-ended (a project
 * with a start and no end is still running), and one-sided windows work by
 * construction — the missing bound just drops its half of the comparison. The
 * third conjunct of the explicit branch stays LOAD-BEARING: a project with
 * both overrides null passes the first two vacuously and would match every
 * window ever chosen; it now reaches the content branches instead, and only a
 * project with no override AND no dated content is dropped — that count is
 * surfaced as `hiddenByDate.projects` (see `buildUndatedProjectWhere`).
 *
 * **NON-RECURSIVE, unlike the TS fold.** A parent matches on its OWN content
 * only; a sub-project's dates do not roll up here, so a bare parent whose
 * children are dated can still fall out of the window. Mirroring the true
 * recursive fold (`aggregateSubtreeDates`, which children DO feed) would need
 * a recursive CTE, and at this scale (75 projects, 15 of them children) it
 * moves nothing — the same deliberate approximation the `startDate` sort in
 * lookup.ts makes, for the same reason. Everything DISPLAYED still comes from
 * the fully-recursive `dates.effectiveStart`/`effectiveEnd`; this only decides
 * membership.
 *
 * `project.startDate` is indexed (`Project_startDate_idx`); the OR-with-NULL
 * shape means Postgres may not use it, which is fine at this row count.
 */
export function dashboardProjectDateCondition(
  filters: Pick<ProjectDashboardFilters, "dateFrom" | "dateTo">,
): SQL | undefined {
  const { dateFrom, dateTo } = filters;
  if (!dateFrom && !dateTo) return undefined;

  return or(
    and(
      dateTo
        ? or(isNull(project.startDate), lte(project.startDate, dateTo))
        : undefined,
      dateFrom
        ? or(isNull(project.endDate), gte(project.endDate, dateFrom))
        : undefined,
      or(isNotNull(project.startDate), isNotNull(project.endDate)),
    ),
    inArray(project.id, datedTaskProjectIds(dateFrom, dateTo)),
    inArray(project.id, datedExpenseProjectIds(dateFrom, dateTo)),
  );
}

function dashboardScopeConditions(
  filters: ProjectDashboardFilters,
  completionIds?: ProjectId[],
): Array<SQL | undefined> {
  return [
    dashboardStatusCondition(filters),
    ...dashboardKindLocationConditions(filters),
    dashboardProjectDateCondition(filters),
    filters.completionYear
      ? inArray(project.id, completionIds ?? [])
      : undefined,
  ];
}

export function buildDashboardProjectWhere(
  filters: ProjectDashboardFilters,
  completionIds?: ProjectId[],
): SQL | undefined {
  return buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    dashboardScopeConditions(filters, completionIds),
  );
}

/**
 * The same scope MINUS the date window, restricted to projects with no dates
 * from ANY source — no `startDate`/`endDate` override AND no dated task or
 * expense of their own — i.e. exactly the rows
 * {@link buildDashboardProjectWhere} drops *purely* for lacking a date, and
 * nothing dropped on status/kind/location/search grounds. Feeds
 * `hiddenByDate.projects`. Only meaningful while a window is set; the caller
 * skips the query otherwise.
 *
 * The two content clauses are the exact complement of the two `inArray`
 * branches in {@link dashboardProjectDateCondition} (unwindowed, so "has dated
 * content" rather than "has content in THIS window") and must stay that way:
 * counting a project as hidden while the date filter is happily matching it
 * double-reports the row, which is a worse lie than the one this pair exists
 * to tell honestly. Non-recursive for the same reason documented there.
 *
 * `notInArray` is safe only because both sub-selects filter `isNotNull` on
 * their nullable `projectId` — see {@link datedTaskProjectIds}.
 */
export function buildUndatedProjectWhere(
  filters: ProjectDashboardFilters,
  completionIds?: ProjectId[],
): SQL | undefined {
  return buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    [
      dashboardStatusCondition(filters),
      ...dashboardKindLocationConditions(filters),
      filters.completionYear
        ? inArray(project.id, completionIds ?? [])
        : undefined,
      isNull(project.startDate),
      isNull(project.endDate),
      notInArray(project.id, datedTaskProjectIds()),
      notInArray(project.id, datedExpenseProjectIds()),
    ],
  );
}

export async function matchingEmbeddedProjectIds(
  db: Database,
  scope: EmbeddedProjectScope,
): Promise<ProjectId[]> {
  const filters: ProjectDashboardFilters = {
    statusScope: scope.statuses,
    kinds: scope.kinds,
    locations: scope.locations,
    search: scope.search,
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    completionYear: scope.completionYear,
  };
  const dated = scope.completionYear ? await loadProjectDateWindows(db) : null;
  const completionIds = dated
    ? dated.tree.allRows
        .filter((row) => {
          const window = dated.dateWindows.get(row.id);
          return (
            window &&
            projectCompletionYear(row, window) === scope.completionYear
          );
        })
        .map((row) => row.id)
    : undefined;
  const rows = await getDb(db)
    .select({ id: project.id })
    .from(project)
    .where(buildDashboardProjectWhere(filters, completionIds));
  return rows.map((row) => row.id);
}
