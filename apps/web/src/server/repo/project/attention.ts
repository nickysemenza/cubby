/**
 * Server-side "Needs Attention" detector for the Overview page — ports the
 * client-side computation from `app/projects/needs-attention.tsx` (overdue
 * tasks, stalled projects, missing budgets) and adds four more rule types:
 * past-due planned expenses, unclassified expenses, blocked work with no
 * unblocked next task, and date-window drift (a manual override that now
 * hides real derived work). See `projectAttentionTypeSchema` in
 * packages/schemas/src/project.ts for the full rule enum.
 *
 * The Problems page computes this globally. The dashboard passes its matched
 * project ids so project-owned results match the visible portfolio while
 * unassigned task/expense results remain visible like the dashboard Data
 * view. Rollups still load the whole tree: filtering the output must not make
 * a matched parent's unmatched child disappear from its subtree spend.
 *
 * Because that scope is the WHOLE tree, the caller's own whole-tree load is
 * the identical query set — hence the optional `preloaded` argument (see
 * `loadProjectSubtreeRollups`). `projectDashboardSummary` passes its bundle
 * in; `problems.service.ts` calls this standalone and lets it load its own.
 */
import { type ProjectId, unsafeProjectId } from "@cubby/schemas/identifiers";
import {
  isLiveProjectStatus,
  type ProjectAttentionItem,
  type ProjectAttentionType,
} from "@cubby/schemas/project";
import {
  type AnyColumn,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import { householdDaysAgo, householdLocalDate } from "~/lib/household-date";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";
import { listActionableTasks } from "~/server/repo/task/actionable";
import {
  loadProjectSubtreeRollups,
  type ProjectSubtreeRollups,
} from "./subtree";

/** `stalled_project`'s no-activity window. */
const STALE_ACTIVITY_DAYS = 30;

/**
 * List-facing names for project-grain attention rules. Both Problems and the
 * Project list reuse this mapping instead of copying detector predicates.
 */
export const projectAttentionFilterTypes = {
  stalled: "stalled_project",
  missing_budget: "missing_budget",
  blocked_no_next_action: "blocked_work",
} as const;

/**
 * Build an item's stable `key`.
 *
 * Most rules emit at most one row per entity, so `type:entityId` identifies
 * them. `date_window_drift` is the exception — it tests the start and end
 * overrides independently, so a project narrowed on both sides emits two rows
 * with the same type and entityId. Those pass a `discriminator`; without one
 * the two rows collided as React keys and the list could silently drop a row.
 * Any future rule that can fire twice for one entity must do the same.
 */
const attentionKey = (
  type: ProjectAttentionType,
  entityId: string,
  discriminator?: string,
): string =>
  discriminator
    ? `${type}:${entityId}:${discriminator}`
    : `${type}:${entityId}`;

export async function computeAttentionItems(
  db: Database,
  options?: {
    /** A whole-tree load the caller already has. */
    preloaded?: ProjectSubtreeRollups;
    /** Matched dashboard projects; omitted means global Problems-page scope. */
    projectIds?: ProjectId[];
  },
): Promise<ProjectAttentionItem[]> {
  const today = householdLocalDate();
  const activityCutoff = householdDaysAgo(STALE_ACTIVITY_DAYS);
  const items: ProjectAttentionItem[] = [];
  const scopedProjectIds = options?.projectIds;
  const scopedOrInbox = (column: AnyColumn) =>
    scopedProjectIds === undefined
      ? undefined
      : scopedProjectIds.length > 0
        ? or(inArray(column, scopedProjectIds), isNull(column))
        : isNull(column);
  const inProjectScope = (projectId: ProjectId | null) =>
    scopedProjectIds === undefined ||
    projectId === null ||
    scopedProjectIds.includes(projectId);
  const projectInScope = (projectId: ProjectId) =>
    scopedProjectIds === undefined || scopedProjectIds.includes(projectId);

  const [
    overdueTaskRows,
    inProgressProjectRows,
    { allRows: allProjectRows, subtreeRollups, dateWindows },
    pastDueExpenseRows,
    unclassifiedExpenseRows,
    actionable,
  ] = await Promise.all([
    getDb(db)
      .select({
        id: task.id,
        shortcode: task.shortcode,
        name: task.name,
        projectId: task.projectId,
        dueDate: task.dueDate,
        dueEndDate: task.dueEndDate,
      })
      .from(task)
      .where(
        and(
          notDeleted(task),
          ne(task.status, "done"),
          isNull(task.parentTaskId),
          scopedOrInbox(task.projectId),
        ),
      ),
    scopedProjectIds?.length === 0
      ? Promise.resolve([])
      : getDb(db)
          .select({
            id: project.id,
            shortcode: project.shortcode,
            name: project.name,
            updatedAt: project.updatedAt,
          })
          .from(project)
          .where(
            and(
              notDeleted(project),
              eq(project.status, "in_progress"),
              scopedProjectIds
                ? inArray(project.id, scopedProjectIds)
                : undefined,
            ),
          ),
    options?.preloaded ?? loadProjectSubtreeRollups(db),
    getDb(db)
      .select({
        id: expense.id,
        shortcode: expense.shortcode,
        name: expense.name,
        projectId: expense.projectId,
        date: expense.date,
      })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          eq(expense.future, true),
          isNotNull(expense.date),
          lt(expense.date, today),
          scopedOrInbox(expense.projectId),
        ),
      ),
    getDb(db)
      .select({
        id: expense.id,
        shortcode: expense.shortcode,
        name: expense.name,
        projectId: expense.projectId,
        date: expense.date,
      })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          eq(expense.trade, "other"),
          eq(expense.lineKind, "principal"),
          isNull(expense.cost),
          scopedOrInbox(expense.projectId),
        ),
      ),
    listActionableTasks(db),
  ]);

  // 1. overdue_task — one item per open top-level task past its effective
  // due date (`dueEndDate ?? dueDate`), matching needs-attention.tsx's
  // per-task granularity (not aggregated per project).
  for (const row of overdueTaskRows) {
    const effectiveDue = effectiveTaskDueDate(row);
    if (!effectiveDue || effectiveDue >= today) continue;
    items.push({
      key: attentionKey("overdue_task", row.shortcode),
      type: "overdue_task",
      severity: "critical",
      description: `"${row.name}" was due ${effectiveDue} and is still open`,
      entityType: "task",
      entityId: row.shortcode,
      date: effectiveDue,
      amount: null,
      href: `/tasks/${row.shortcode}`,
    });
  }

  // 2. stalled_project — in_progress project with no project/task/expense
  // activity in the last 30 days. (Note/image activity isn't included — no
  // cheap existing "last activity" timestamp for those; see module doc.)
  //
  // Task activity is `max(dueEndDate ?? dueDate)`, NOT `max(updatedAt)`.
  // Measured on production: 1,111 of 1,116 done tasks were Notion-imported in
  // one window, so `updatedAt` spans only 2 distinct months (2026-07-18 →
  // 2026-08-12) while `dueDate` spans 32 months (2023-10 → 2026-08) — the real
  // work timeline. Zero rows have `dueDate` equal to `updatedAt`'s day; 1,110
  // are off by 30+ days. `max(updatedAt)` therefore dates every project to the
  // import, not the work, and can't tell a live project from a dormant one.
  // `dueDate` also does double duty as a *forward* signal: a task due next
  // month means the project has scheduled live work, so it correctly reads as
  // "not stalled" even before that task is touched again.
  //
  // `dueDate` is nullable (1,116 done tasks have 1 without one; 100% of
  // `later`/`blocked` tasks lack one). SQL `max()` already ignores NULLs, so a
  // project whose tasks are all undated simply gets no task-activity signal —
  // it neither widens (falsely "recent") nor collapses (falsely "ancient")
  // the window; `project.updatedAt` and expense activity still apply.
  const inProgressIds = inProgressProjectRows.map((r) => r.id);
  const [taskActivityRows, expenseActivityRows] = await Promise.all([
    inProgressIds.length > 0
      ? getDb(db)
          .select({
            projectId: task.projectId,
            lastActivity: sql<
              string | null
            >`max(coalesce(${task.dueEndDate}, ${task.dueDate}))`,
          })
          .from(task)
          .where(and(inArray(task.projectId, inProgressIds), notDeleted(task)))
          .groupBy(task.projectId)
      : Promise.resolve([]),
    inProgressIds.length > 0
      ? getDb(db)
          .select({
            projectId: expense.projectId,
            lastActivity: sql<string>`max(${expense.date})`,
          })
          .from(expense)
          .where(
            and(inArray(expense.projectId, inProgressIds), notDeleted(expense)),
          )
          .groupBy(expense.projectId)
      : Promise.resolve([]),
  ]);
  const taskActivityByProject = new Map<ProjectId, string>();
  for (const row of taskActivityRows) {
    if (row.projectId && row.lastActivity)
      taskActivityByProject.set(row.projectId, row.lastActivity);
  }
  const expenseActivityByProject = new Map<ProjectId, string>();
  for (const row of expenseActivityRows) {
    if (row.projectId)
      expenseActivityByProject.set(row.projectId, row.lastActivity);
  }

  for (const row of inProgressProjectRows) {
    const candidates = [
      householdLocalDate(row.updatedAt),
      taskActivityByProject.get(row.id),
      expenseActivityByProject.get(row.id),
    ].filter((d): d is string => d != null);
    const lastActivityDate = candidates.reduce((latest, d) =>
      d > latest ? d : latest,
    );
    if (lastActivityDate >= activityCutoff) continue;
    items.push({
      key: attentionKey("stalled_project", row.shortcode),
      type: "stalled_project",
      severity: "warning",
      description: `"${row.name}" has had no project, task, or expense activity in ${STALE_ACTIVITY_DAYS}+ days`,
      entityType: "project",
      entityId: row.shortcode,
      date: lastActivityDate,
      amount: null,
      href: `/projects/${row.shortcode}`,
    });
  }

  // 3. missing_budget — subtree actual+committed spend > 0, subtree
  // costEstimate still null. Reuses the same batched rollup/aggregation the
  // project reads use — never re-derived here.
  //
  // Restricted to LIVE projects. A `done` project's budget estimate is a
  // forecast for work that already happened, so asking for one is busywork that
  // can never be "wrong" — and it dominated the count (29 of 32 flagged rows
  // were finished projects like a completed wedding and a replaced furnace).
  // Rule 2 above already scopes itself this way; this rule simply didn't.
  for (const row of allProjectRows) {
    if (!projectInScope(row.id)) continue;
    if (!isLiveProjectStatus(row.status)) continue;
    const subtree = subtreeRollups.get(row.id);
    if (!subtree) continue;
    const spend = subtree.actualSpent + subtree.committedSpent;
    if (spend > 0 && subtree.costEstimate === null) {
      items.push({
        key: attentionKey("missing_budget", row.shortcode),
        type: "missing_budget",
        severity: "info",
        // Not `formatCurrency`: that helper lives in `~/lib/utils`, a
        // client-side module with no existing server import (grep confirms
        // zero); a whole-digit `$`-prefix here is a deliberate no-cents
        // summary, not a rendering shortcut.
        description: `"${row.name}" has $${spend.toFixed(0)} in spend but no budget estimate`,
        entityType: "project",
        entityId: row.shortcode,
        date: null,
        amount: spend,
        href: `/projects/${row.shortcode}`,
      });
    }
  }

  // 4. past_due_planned_expense
  for (const row of pastDueExpenseRows) {
    items.push({
      key: attentionKey("past_due_planned_expense", row.shortcode),
      type: "past_due_planned_expense",
      severity: "warning",
      description: `"${row.name}" was planned for ${row.date} but hasn't been logged as spent`,
      entityType: "expense",
      entityId: row.shortcode,
      date: row.date,
      amount: null,
      href: `/expenses/${row.shortcode}`,
    });
  }

  // 5. unclassified_expense — trade left at the catch-all "other" AND no
  // cost logged (costType itself stays a clean 3-value enum — no
  // "uncategorized" value added there).
  for (const row of unclassifiedExpenseRows) {
    items.push({
      key: attentionKey("unclassified_expense", row.shortcode),
      type: "unclassified_expense",
      severity: "info",
      description: `"${row.name}" has no trade or cost recorded`,
      entityType: "expense",
      entityId: row.shortcode,
      date: row.date,
      amount: null,
      href: `/expenses/${row.shortcode}`,
    });
  }

  // 6. blocked_work — in_progress project with >=1 blocked task and zero
  // unblocked `next` tasks (no available next action).
  //
  // `actionable`'s tasks carry the public `projectId` (a shortcode); resolve
  // the ones in play back to the uuid this file's Sets/`inProjectScope` key
  // on, in ONE batched lookup rather than per-task.
  const actionableProjectCodes = uniq(
    [
      ...actionable.next.map((t) => t.projectId),
      ...actionable.blocked.map((b) => b.task.projectId),
    ].filter((code): code is NonNullable<typeof code> => code != null),
  );
  const actionableProjectRefs = await resolveShortcodes(
    db,
    actionableProjectCodes,
  );
  const toProjectUuid = (code: string): ProjectId | null => {
    const ref = actionableProjectRefs.get(code);
    return ref ? unsafeProjectId(ref.id) : null;
  };

  const projectsWithNext = new Set<ProjectId>();
  for (const t of actionable.next) {
    const projectId = t.projectId ? toProjectUuid(t.projectId) : null;
    if (projectId && inProjectScope(projectId)) projectsWithNext.add(projectId);
  }
  const projectsWithBlocked = new Set<ProjectId>();
  for (const b of actionable.blocked) {
    const projectId = b.task.projectId ? toProjectUuid(b.task.projectId) : null;
    if (projectId && inProjectScope(projectId))
      projectsWithBlocked.add(projectId);
  }
  for (const row of inProgressProjectRows) {
    if (projectsWithBlocked.has(row.id) && !projectsWithNext.has(row.id)) {
      items.push({
        key: attentionKey("blocked_work", row.shortcode),
        type: "blocked_work",
        severity: "warning",
        description: `"${row.name}" has blocked tasks and no unblocked next action`,
        entityType: "project",
        entityId: row.shortcode,
        date: null,
        amount: null,
        href: `/projects/${row.shortcode}`,
      });
    }
  }

  // 7. date_window_drift — a manual startDate/endDate override that now hides
  // real derived work (own tasks/expenses, folded up through live
  // sub-projects). Checked independently per side against `row`'s raw
  // override columns (not `dates.effectiveStart/End`, which the override
  // itself determines) vs. the corresponding `derivedStart`/`derivedEnd`. A
  // WIDER override (e.g. a deliberate forward end date with nothing dated
  // out there yet) is intent, not drift, so only a too-narrow override
  // fires — and an override that exactly equals the derived bound doesn't
  // either.
  for (const row of allProjectRows) {
    if (!projectInScope(row.id)) continue;
    const window = dateWindows.get(row.id);
    if (!window) continue;
    if (
      row.startDate != null &&
      window.derivedStart != null &&
      row.startDate > window.derivedStart
    ) {
      items.push({
        key: attentionKey("date_window_drift", row.shortcode, "start"),
        type: "date_window_drift",
        severity: "info",
        description: `Start date ${row.startDate} is after the earliest dated work (${window.derivedStart})`,
        entityType: "project",
        entityId: row.shortcode,
        date: window.derivedStart,
        amount: null,
        href: `/projects/${row.shortcode}`,
      });
    }
    if (
      row.endDate != null &&
      window.derivedEnd != null &&
      row.endDate < window.derivedEnd
    ) {
      items.push({
        key: attentionKey("date_window_drift", row.shortcode, "end"),
        type: "date_window_drift",
        severity: "info",
        description: `End date ${row.endDate} is before the latest dated work (${window.derivedEnd})`,
        entityType: "project",
        entityId: row.shortcode,
        date: window.derivedEnd,
        amount: null,
        href: `/projects/${row.shortcode}`,
      });
    }
  }

  return items;
}
