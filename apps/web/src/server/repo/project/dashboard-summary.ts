/**
 * `project.dashboardSummary` — everything `/projects?view=overview` renders
 * in one bounded round trip (replaces the old fetch-all `project.dashboard`):
 * summary counts, the active-project list (with rollups), per-project task
 * status breakdown, upcoming tasks, Needs Attention items, filter option
 * sets (including the year chips), the completed-project count, and the
 * "hidden purely for having no date" counts behind the date chips. See
 * packages/schemas/src/project.ts's `projectDashboardSummaryOut` doc comment.
 */
import {
  type ProjectId,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProjectDashboardSummaryInput,
  ProjectDashboardSummaryOut,
  ProjectTaskStatusBreakdown,
  TaskStatus,
} from "@cubby/schemas/project";
import type { AnyColumn } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { sumBy, uniq } from "es-toolkit";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import {
  countWhere,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { taskDependencyIds, taskSubtaskCounts } from "~/server/repo/task/crud";
import {
  dbTaskToAPI,
  effectiveTaskDueDateSql,
} from "~/server/repo/task/helpers";
import { projectDependencyIds } from "./analytics";
import { computeAttentionItems } from "./attention";
import {
  buildDashboardProjectWhere,
  buildUndatedProjectWhere,
  dashboardKindLocationConditions,
} from "./dashboard-shared";
import { EMPTY_PROJECT_SUBTREE_ROLLUP, hydrateProjectRow } from "./helpers";
import {
  collectDescendantIds,
  loadProjectSubtreeRollups,
  projectCompletionYear,
} from "./subtree";

/**
 * Forward-looking committed-spend windows, in days from today. Mirrors the
 * "30/60/90-day AP aging" convention: each window is cumulative (spend due
 * *by* that many days out, including anything already overdue-but-unspent),
 * not a disjoint bucket — so `in90Days` is always >= `in60Days` >= `in30Days`.
 */
const FORWARD_COMMITTED_WINDOWS_DAYS = [30, 60, 90] as const;

/** Cap on `nextTasks` — a preview strip, not a full list (see `task.board`/`task.listActionable` for those). */
const NEXT_TASKS_CAP = 10;

/**
 * Which breakdown counter each task status increments. A finite-key `Record`
 * rather than a `switch`, so adding a `TaskStatus` is a compile error here
 * instead of that status silently vanishing from every project's breakdown
 * (see CLAUDE.md's finite-enum-Record convention).
 */
const TASK_STATUS_FIELD: Record<
  TaskStatus,
  Exclude<keyof ProjectTaskStatusBreakdown, "projectId">
> = {
  not_started: "notStarted",
  later: "later",
  in_progress: "inProgress",
  blocked: "blocked",
  done: "done",
};

export async function projectDashboardSummary(
  db: Database,
  filters: ProjectDashboardSummaryInput,
): Promise<ProjectDashboardSummaryOut> {
  // ONE whole-tree load for the entire request. `computeAttentionItems` is
  // global by construction (see attention.ts) and used to re-derive exactly
  // this — same tree query, same batched `projectRollups` — so it is handed
  // the bundle rather than loading its own. Whole-tree rather than
  // page-scoped is free here for the same reason: attention already needed
  // every id, and a superset never changes a page row's subtree numbers.
  const subtreeLoad = await loadProjectSubtreeRollups(db);
  const { subtreeRollups, dateWindows, allRows } = subtreeLoad;
  const completionIds = filters.completionYear
    ? allRows
        .filter((row) => {
          const window = dateWindows.get(row.id);
          return (
            window &&
            projectCompletionYear(row, window) === filters.completionYear
          );
        })
        .map((row) => row.id)
    : undefined;

  // Carries status + kind/location + the date window (see dashboard-shared.ts).
  const scopedWhere = buildDashboardProjectWhere(filters, completionIds);
  const kindLocationConditions = dashboardKindLocationConditions(filters);
  const today = householdLocalDate();
  const dateFilterActive = Boolean(filters.dateFrom || filters.dateTo);

  const [
    projectRows,
    activeProjectCount,
    completedCount,
    undatedProjectCount,
    kindRows,
    locationRows,
    expenseYearRows,
    taskYearRows,
    projectYearRows,
  ] = await Promise.all([
    getDb(db).query.project.findMany({
      where: scopedWhere,
      orderBy: [asc(project.name)],
    }),
    // Portfolio headline stats keep a fixed status. `completedCount` is fully
    // unscoped because its link applies only the Completed saved filter; the
    // number and destination therefore use the exact same predicate.
    countWhere(
      db,
      project,
      and(
        notDeleted(project),
        ne(project.status, "done"),
        ...kindLocationConditions,
      ),
    ),
    countWhere(
      db,
      project,
      and(notDeleted(project), eq(project.status, "done")),
    ),
    dateFilterActive
      ? countWhere(
          db,
          project,
          buildUndatedProjectWhere(filters, completionIds),
        )
      : Promise.resolve(0),
    getDb(db)
      .selectDistinct({ kind: project.kind })
      .from(project)
      .where(notDeleted(project)),
    getDb(db)
      .selectDistinct({
        location: sql<string>`unnest(${project.locations})`,
      })
      .from(project)
      .where(notDeleted(project)),
    // Year chips come from the DATA, deliberately unscoped by the current
    // filters — the Date row must offer the same years on every tab. They
    // used to be reduced client-side from the Data view's fetch-alls, which
    // are `enabled: view === "data"`, so a fresh Overview/Analytics load
    // showed only the relative presets.
    getDb(db)
      .selectDistinct({ year: sql<string>`to_char(${expense.date}, 'YYYY')` })
      .from(expense)
      .where(and(notDeleted(expense), isNotNull(expense.date))),
    // Tasks contribute their EFFECTIVE due date (`dueEndDate ?? dueDate`) —
    // the same expression task/lookup.ts filters due windows on.
    getDb(db)
      .selectDistinct({
        year: sql<string>`to_char(${effectiveTaskDueDateSql()}, 'YYYY')`,
      })
      .from(task)
      .where(
        and(
          notDeleted(task),
          or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
        ),
      ),
    // A project contributes BOTH bounds (a 2023→2025 renovation lights up
    // both ends); `array_remove(…, null)` drops whichever side is missing.
    getDb(db)
      .selectDistinct({
        year: sql<string>`unnest(array_remove(array[to_char(${project.startDate}, 'YYYY'), to_char(${project.endDate}, 'YYYY')], null))`,
      })
      .from(project)
      .where(
        and(
          notDeleted(project),
          or(isNotNull(project.startDate), isNotNull(project.endDate)),
        ),
      ),
  ]);

  const ids = projectRows.map((r) => r.id);

  /**
   * Mirrors the Data view's client-side join (projects-dashboard.tsx): a row
   * belongs to the scoped set when its project matched OR it has no project
   * at all — that view keeps inbox rows visible regardless of project scope.
   */
  const scopedOrInbox = (column: AnyColumn) =>
    ids.length > 0 ? or(inArray(column, ids), isNull(column)) : isNull(column);

  // Same population `committedSpend` reads (each scoped project's own subtree),
  // flattened to a deduped id set so ONE grouped query can add the date filter
  // `subtreeRollups` doesn't carry. Unlike `actualSpend`/`committedSpend`'s
  // per-top-level-id sum, this can't double-count a matched parent+child pair —
  // the id set is deduped before the query runs.
  const expandedProjectIds = uniq([
    ...ids,
    ...ids.flatMap((id) =>
      collectDescendantIds(subtreeLoad.childrenByParent, id),
    ),
  ]);

  const [
    deps,
    taskStatusRows,
    nextTaskRows,
    undatedTaskCount,
    undatedExpenseCount,
    attention,
    forwardCommittedRows,
  ] = await Promise.all([
    projectDependencyIds(db, ids),
    ids.length > 0
      ? getDb(db)
          .select({
            projectId: task.projectId,
            status: task.status,
            count: sql<number>`count(*)::int`,
          })
          .from(task)
          .where(
            and(
              inArray(task.projectId, ids),
              notDeleted(task),
              isNull(task.parentTaskId),
            ),
          )
          .groupBy(task.projectId, task.status)
      : Promise.resolve([]),
    ids.length > 0
      ? getDb(db).query.task.findMany({
          where: and(
            inArray(task.projectId, ids),
            notDeleted(task),
            isNull(task.parentTaskId),
            inArray(task.status, ["not_started", "in_progress"]),
          ),
          // Overdue-first, then effective due date ascending (nulls last),
          // then name — a cheap approximation of listActionableTasks'
          // `next` ordering (it also excludes dependency-blocked tasks,
          // which this skips to stay a single query for a 10-row preview).
          orderBy: [
            sql`(${effectiveTaskDueDateSql()} < ${today}) desc`,
            sql`${effectiveTaskDueDateSql()} asc nulls last`,
            asc(task.name),
          ],
          limit: NEXT_TASKS_CAP,
          ...relations.task.withProject,
        })
      : Promise.resolve([]),
    // Rows the date window drops purely for having NO date — never rows that
    // simply fall outside it (those are excluded on their own merits, which
    // the chip already states). A task on a project that itself dropped out
    // of the window is deliberately NOT counted here either: it's hidden for
    // a different reason, and `hiddenByDate.projects` is where that surfaces.
    dateFilterActive
      ? countWhere(
          db,
          task,
          and(
            notDeleted(task),
            scopedOrInbox(task.projectId),
            isNull(task.dueDate),
            isNull(task.dueEndDate),
          ),
        )
      : Promise.resolve(0),
    // Expense.date is required; only Projects and Tasks can be hidden solely
    // because their date is missing.
    Promise.resolve(0),
    computeAttentionItems(db, { preloaded: subtreeLoad, projectIds: ids }),
    expandedProjectIds.length > 0
      ? getDb(db)
          .select({
            in30Days: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.date} <= ${householdDaysFromNow(FORWARD_COMMITTED_WINDOWS_DAYS[0])}), 0)::float`,
            in60Days: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.date} <= ${householdDaysFromNow(FORWARD_COMMITTED_WINDOWS_DAYS[1])}), 0)::float`,
            in90Days: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.date} <= ${householdDaysFromNow(FORWARD_COMMITTED_WINDOWS_DAYS[2])}), 0)::float`,
          })
          .from(expense)
          .where(
            and(
              inArray(expense.projectId, expandedProjectIds),
              notDeleted(expense),
              eq(expense.future, true),
              gt(expense.cost, 0),
            ),
          )
      : Promise.resolve([{ in30Days: 0, in60Days: 0, in90Days: 0 }]),
  ]);

  const projects = projectRows.map((row) =>
    hydrateProjectRow(row, subtreeLoad, deps),
  );

  // Every non-done top-level task on a scoped project — exactly
  // `taskStatusRows`' own predicates plus `status != 'done'`, so it's summed
  // from the rows already in hand rather than costing another round trip.
  const openTaskCount = sumBy(
    taskStatusRows.filter((row) => row.status !== "done"),
    (row) => row.count,
  );

  // actualSpend/committedSpend: sum of each matching project's OWN subtree
  // total (matches what each project's card shows) — note this double-counts
  // a parent+child pair when BOTH independently match the filter (e.g. both
  // `in_progress`), since the child's numbers are already folded into the
  // parent's subtree. Accepted as a judgment call — see the task report.
  const subtreeOf = (id: ProjectId) =>
    subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP;
  const actualSpend = sumBy(ids, (id) => subtreeOf(id).actualSpent);
  const committedSpend = sumBy(ids, (id) => subtreeOf(id).committedSpent);
  // Missing per-project estimates contribute 0, same as the zero rollup does
  // for actual/committedSpend — an unestimated project doesn't widen the
  // portfolio total, it just adds nothing to it.
  const estimateTotal = sumBy(ids, (id) => subtreeOf(id).costEstimate ?? 0);
  const forwardCommittedSpend = forwardCommittedRows[0] ?? {
    in30Days: 0,
    in60Days: 0,
    in90Days: 0,
  };

  const statusByProject = new Map<ProjectId, ProjectTaskStatusBreakdown>();
  for (const id of ids) {
    statusByProject.set(id, {
      projectId: unsafeProjectShortcode(
        subtreeLoad.shortcodeById.get(id) ?? "",
      ),
      notStarted: 0,
      later: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    });
  }
  for (const row of taskStatusRows) {
    if (!row.projectId) continue;
    const entry = statusByProject.get(row.projectId);
    if (!entry) continue;
    entry[TASK_STATUS_FIELD[row.status]] = row.count;
  }

  const nextTaskIds = nextTaskRows.map((r) => r.id);
  const [nextDeps, nextSubtaskCounts] = await Promise.all([
    taskDependencyIds(db, nextTaskIds),
    taskSubtaskCounts(db, nextTaskIds),
  ]);
  const nextTasks = nextTaskRows.map((row) => {
    const counts = nextSubtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      nextDeps.blockedBy.get(row.id) ?? [],
      nextDeps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  });

  const kinds = uniq(
    kindRows
      .map((r) => r.kind)
      .filter((k): k is NonNullable<typeof k> => k != null),
  );
  const locations = uniq(locationRows.map((r) => r.location)).sort();
  // Newest year first — the chip row reads most-recent-first.
  const years = uniq([
    ...expenseYearRows.map((r) => r.year),
    ...taskYearRows.map((r) => r.year),
    ...projectYearRows.map((r) => r.year),
  ])
    .sort()
    .reverse();
  const completionYears = uniq(
    allRows.flatMap((row) => {
      const window = dateWindows.get(row.id);
      return window ? [projectCompletionYear(row, window)] : [];
    }),
  )
    .sort()
    .reverse();

  return {
    summary: {
      activeProjectCount,
      openTaskCount,
      actualSpend,
      committedSpend,
      estimateTotal,
      forwardCommittedSpend,
    },
    projects,
    taskStatusByProject: [...statusByProject.values()],
    nextTasks,
    attention,
    filterOptions: { kinds, locations, years, completionYears },
    hiddenByDate: {
      projects: undatedProjectCount,
      tasks: undatedTaskCount,
      expenses: undatedExpenseCount,
    },
    completedCount,
  };
}
