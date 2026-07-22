/**
 * `project.dashboardSummary` — everything `/projects?view=overview` renders
 * in one bounded round trip (replaces the old fetch-all `project.dashboard`):
 * summary counts, the active-project list (with rollups), per-project task
 * status breakdown, upcoming tasks, Needs Attention items, filter option
 * sets, and the completed-project count. See
 * packages/schemas/src/project.ts's `projectDashboardSummaryOut` doc comment.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectDashboardSummaryInput,
  ProjectDashboardSummaryOut,
  ProjectTaskStatusBreakdown,
} from "@cubby/schemas/project";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { project, task } from "~/server/db/schema";
import {
  countWhere,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { taskDependencyIds, taskSubtaskCounts } from "~/server/repo/task/crud";
import { dbTaskToAPI } from "~/server/repo/task/helpers";
import { projectDependencyIds, projectRollups } from "./analytics";
import { computeAttentionItems } from "./attention";
import {
  buildDashboardProjectWhere,
  dashboardKindLocationConditions,
} from "./dashboard-shared";
import {
  dbProjectToAPI,
  EMPTY_PROJECT_OWN_ROLLUP,
  EMPTY_PROJECT_SUBTREE_ROLLUP,
} from "./helpers";
import {
  aggregateSubtreeRollups,
  allProjectParentRows,
  buildChildrenMap,
  collectDescendantIds,
} from "./subtree";

/** Cap on `nextTasks` — a preview strip, not a full list (see `task.board`/`task.listActionable` for those). */
const NEXT_TASKS_CAP = 10;

export async function projectDashboardSummary(
  db: Database,
  filters: ProjectDashboardSummaryInput,
): Promise<ProjectDashboardSummaryOut> {
  const allRows = await allProjectParentRows(db);
  const childrenByParent = buildChildrenMap(allRows);
  const nameById = new Map(allRows.map((r) => [r.id, r.name]));

  const scopedWhere = buildDashboardProjectWhere(filters);
  const kindLocationConditions = dashboardKindLocationConditions(filters);
  const today = householdLocalDate();

  const [
    projectRows,
    activeProjectCount,
    completedCount,
    kindRows,
    locationRows,
    attention,
  ] = await Promise.all([
    getDb(db).query.project.findMany({
      where: scopedWhere,
      orderBy: [asc(project.name)],
    }),
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
      and(
        notDeleted(project),
        eq(project.status, "done"),
        ...kindLocationConditions,
      ),
    ),
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
    computeAttentionItems(db),
  ]);

  const ids = projectRows.map((r) => r.id);
  const descendantIds = ids.flatMap((id) =>
    collectDescendantIds(childrenByParent, id),
  );

  const [rollups, deps, taskStatusRows, openTaskCount, nextTaskRows] =
    await Promise.all([
      projectRollups(db, uniq([...ids, ...descendantIds])),
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
        ? countWhere(
            db,
            task,
            and(
              inArray(task.projectId, ids),
              notDeleted(task),
              ne(task.status, "done"),
              isNull(task.parentTaskId),
            ),
          )
        : Promise.resolve(0),
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
              sql`(coalesce(${task.dueEndDate}, ${task.dueDate}) < ${today}) desc`,
              sql`coalesce(${task.dueEndDate}, ${task.dueDate}) asc nulls last`,
              asc(task.name),
            ],
            limit: NEXT_TASKS_CAP,
            ...relations.task.withProject,
          })
        : Promise.resolve([]),
    ]);

  const subtreeRollups = aggregateSubtreeRollups(allRows, rollups);
  const projects = projectRows.map((row) =>
    dbProjectToAPI(
      row,
      rollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
      subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      row.parentProjectId ? (nameById.get(row.parentProjectId) ?? null) : null,
      childrenByParent.get(row.id) ?? [],
    ),
  );

  // actualSpend/committedSpend: sum of each matching project's OWN subtree
  // total (matches what each project's card shows) — note this double-counts
  // a parent+child pair when BOTH independently match the filter (e.g. both
  // `in_progress`), since the child's numbers are already folded into the
  // parent's subtree. Accepted as a judgment call — see the task report.
  let actualSpend = 0;
  let committedSpend = 0;
  for (const id of ids) {
    const subtree = subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP;
    actualSpend += subtree.actualSpent;
    committedSpend += subtree.committedSpent;
  }

  const statusByProject = new Map<ProjectId, ProjectTaskStatusBreakdown>();
  for (const id of ids) {
    statusByProject.set(id, {
      projectId: id,
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
    switch (row.status) {
      case "not_started":
        entry.notStarted = row.count;
        break;
      case "later":
        entry.later = row.count;
        break;
      case "in_progress":
        entry.inProgress = row.count;
        break;
      case "blocked":
        entry.blocked = row.count;
        break;
      case "done":
        entry.done = row.count;
        break;
    }
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

  return {
    summary: { activeProjectCount, openTaskCount, actualSpend, committedSpend },
    projects,
    taskStatusByProject: [...statusByProject.values()],
    nextTasks,
    attention,
    filterOptions: { kinds, locations },
    completedCount,
  };
}
