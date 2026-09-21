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
import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  describeAttentionItem,
  isLiveProjectStatus,
  type ProjectAttentionDescribable,
  type ProjectAttentionItem,
  type ProjectAttentionType,
  projectAttentionItemSchema,
} from "@cubby/schemas/project";
import {
  type SQL,
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

import {
  householdDaysAgo,
  householdLocalDate,
  plainDateDaysBetween,
} from "~/lib/household-date";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/repo/expense-inheritance";
import {
  expenseAllocatedCostSql,
  expenseAllocationExistsSql,
  expenseProjectAllocationSql,
} from "~/server/repo/expense-project-allocation";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";
import { effectiveTaskProjectSql } from "~/server/repo/task-project-inheritance";
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

/**
 * Build one row. Exists so `description` is never hand-written at a rule site:
 * every sentence comes from the shared `describeAttentionItem`, which is what
 * keeps the Problems page, the projects dashboard and the MCP tools reading the
 * same words. Rule sites supply identity plus the measurements they tested.
 */
const attentionItem = <T extends ProjectAttentionType>(
  row: ProjectAttentionDescribable & { type: T } & {
    severity: ProjectAttentionItem["severity"];
    entityType: ProjectAttentionItem["entityType"];
    entityId: string;
    date: string | null;
    amount: number | null;
    href: string;
    discriminator?: string;
  },
): ProjectAttentionItem =>
  projectAttentionItemSchema.parse({
    key: attentionKey(row.type, row.entityId, row.discriminator),
    type: row.type,
    severity: row.severity,
    name: row.name,
    description: describeAttentionItem(row),
    entityType: row.entityType,
    entityId: row.entityId,
    date: row.date,
    amount: row.amount,
    href: row.href,
    facts: row.facts,
  });

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
  const scopedOrInbox = (column: SQL) =>
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
        projectId: effectiveTaskProjectSql(),
        dueDate: task.dueDate,
        dueEndDate: task.dueEndDate,
      })
      .from(task)
      .where(
        and(
          notDeleted(task),
          ne(task.status, "done"),
          isNull(task.parentTaskId),
          scopedOrInbox(effectiveTaskProjectSql()),
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
        projectId: effectiveExpenseProjectSql(),
        date: expense.date,
        // What the line was planned to cost — the card leads with the money,
        // which is the whole reason an un-logged plan matters.
        cost:
          scopedProjectIds === undefined
            ? expense.cost
            : expenseAllocatedCostSql(sql`${expense.id}`, {
                projectIds: scopedProjectIds,
                presence: "none",
              }),
      })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          eq(expense.future, true),
          isNotNull(expense.date),
          lt(expense.date, today),
          scopedProjectIds === undefined
            ? undefined
            : expenseAllocationExistsSql(sql`${expense.id}`, {
                projectIds: scopedProjectIds,
                presence: "none",
              }),
        ),
      ),
    getDb(db)
      .select({
        id: expense.id,
        shortcode: expense.shortcode,
        name: expense.name,
        projectId: effectiveExpenseProjectSql(),
        date: expense.date,
      })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          eq(effectiveExpenseTradeSql(), "other"),
          eq(expense.lineKind, "principal"),
          isNull(expense.cost),
          scopedProjectIds === undefined
            ? undefined
            : expenseAllocationExistsSql(sql`${expense.id}`, {
                projectIds: scopedProjectIds,
                presence: "none",
              }),
        ),
      ),
    listActionableTasks(db),
  ]);

  // 1. overdue_task — one item per open top-level task past its effective
  // due date (`dueEndDate ?? dueDate`), matching needs-attention.tsx's
  // per-task granularity (not aggregated per project).
  const appendOverdueTasks = () => {
    for (const row of overdueTaskRows) {
      const effectiveDue = effectiveTaskDueDate(row);
      if (!effectiveDue || effectiveDue >= today) continue;
      items.push(
        attentionItem({
          type: "overdue_task",
          severity: "critical",
          name: row.name,
          entityType: "task",
          entityId: row.shortcode,
          date: effectiveDue,
          amount: null,
          href: `/tasks/${row.shortcode}`,
          facts: {
            due: effectiveDue,
            daysOverdue: plainDateDaysBetween(effectiveDue, today),
          },
        }),
      );
    }
  };
  appendOverdueTasks();

  // 2. stalled_project — in_progress project with no project/task/expense
  // activity in the last 30 days. (Note/image activity isn't included — no
  // cheap existing "last activity" timestamp for those; see module doc.)
  //
  // Task activity is `max(dueEndDate ?? dueDate)`, NOT `max(updatedAt)`. In
  // production almost all done tasks were bulk-imported in one window, so
  // `updatedAt` clusters tightly around the import while `dueDate` spans the
  // real work timeline, and the two rarely land on the same day.
  // `max(updatedAt)` therefore dates every project to the import, not the
  // work, and can't tell a live project from a dormant one.
  // `dueDate` also does double duty as a *forward* signal: a task due next
  // month means the project has scheduled live work, so it correctly reads as
  // "not stalled" even before that task is touched again.
  //
  // `dueDate` is nullable (1,116 done tasks have 1 without one; 100% of
  // `later`/`blocked` tasks lack one). SQL `max()` already ignores NULLs, so a
  // project whose tasks are all undated simply gets no task-activity signal —
  // it neither widens (falsely "recent") nor collapses (falsely "ancient")
  // the window; `project.updatedAt` and expense activity still apply.
  const appendStalledProjects = async () => {
    const inProgressIds = inProgressProjectRows.map((row) => row.id);
    if (inProgressIds.length === 0) return;
    const [taskActivityRows, expenseActivityRows] = await Promise.all([
      getDb(db)
        .select({
          projectId: effectiveTaskProjectSql(),
          lastActivity: sql<
            string | null
          >`max(coalesce(${task.dueEndDate}, ${task.dueDate}))`,
        })
        .from(task)
        .where(
          and(
            inArray(effectiveTaskProjectSql(), inProgressIds),
            notDeleted(task),
          ),
        )
        .groupBy(effectiveTaskProjectSql()),
      getDb(db)
        .execute<{ projectId: ProjectId; lastActivity: string | null }>(sql`
        SELECT allocation."projectId", max(e."date") AS "lastActivity"
        FROM (${expenseProjectAllocationSql()}) allocation
        JOIN "Expense" e ON e."id" = allocation."expenseId"
        WHERE ${inArray(sql`allocation."projectId"`, inProgressIds)}
        GROUP BY allocation."projectId"
      `)
        .then((result) => result.rows),
    ]);
    const taskActivityByProject = new Map<ProjectId, string>();
    for (const row of taskActivityRows) {
      if (row.projectId && row.lastActivity) {
        taskActivityByProject.set(row.projectId, row.lastActivity);
      }
    }
    const expenseActivityByProject = new Map<ProjectId, string>();
    for (const row of expenseActivityRows) {
      if (row.projectId && row.lastActivity)
        expenseActivityByProject.set(row.projectId, row.lastActivity);
    }
    for (const row of inProgressProjectRows) {
      const candidates = [
        householdLocalDate(row.updatedAt),
        taskActivityByProject.get(row.id),
        expenseActivityByProject.get(row.id),
      ].filter((date): date is string => date != null);
      const lastActivityDate = candidates.reduce((latest, date) =>
        date > latest ? date : latest,
      );
      if (lastActivityDate >= activityCutoff) continue;
      items.push(
        attentionItem({
          type: "stalled_project",
          severity: "warning",
          name: row.name,
          entityType: "project",
          entityId: row.shortcode,
          date: lastActivityDate,
          amount: null,
          href: `/projects/${row.shortcode}`,
          facts: {
            lastActivity: lastActivityDate,
            daysSinceActivity: plainDateDaysBetween(lastActivityDate, today),
            thresholdDays: STALE_ACTIVITY_DAYS,
          },
        }),
      );
    }
  };
  await appendStalledProjects();

  // 3. missing_budget — subtree actual+committed spend > 0, subtree
  // costEstimate still null. Reuses the same batched rollup/aggregation the
  // project reads use — never re-derived here.
  //
  // Restricted to LIVE projects. A `done` project's budget estimate is a
  // forecast for work that already happened, so asking for one is busywork that
  // can never be "wrong" — and it dominated the count (29 of 32 flagged rows
  // were finished projects like a completed wedding and a replaced furnace).
  // Rule 2 above already scopes itself this way; this rule simply didn't.
  const appendMissingBudgets = () => {
    for (const row of allProjectRows) {
      if (!projectInScope(row.id) || !isLiveProjectStatus(row.status)) continue;
      const subtree = subtreeRollups.get(row.id);
      if (!subtree) continue;
      const spend = subtree.actualSpent + subtree.committedSpent;
      if (spend <= 0 || subtree.costEstimate !== null) continue;
      items.push(
        attentionItem({
          type: "missing_budget",
          severity: "info",
          name: row.name,
          entityType: "project",
          entityId: row.shortcode,
          date: null,
          amount: spend,
          href: `/projects/${row.shortcode}`,
          facts: {
            spend,
            actualSpend: subtree.actualSpent,
            committedSpend: subtree.committedSpent,
          },
        }),
      );
    }
  };
  appendMissingBudgets();

  // 4. past_due_planned_expense
  const appendPastDueExpenses = () => {
    for (const row of pastDueExpenseRows) {
      if (row.date === null) {
        throw new Error("Past-due expense query returned a null date");
      }
      const plannedFor = row.date;
      items.push(
        attentionItem({
          type: "past_due_planned_expense",
          severity: "warning",
          name: row.name,
          entityType: "expense",
          entityId: row.shortcode,
          date: plannedFor,
          amount: row.cost,
          href: `/expenses/${row.shortcode}`,
          facts: {
            plannedFor,
            daysPastDue: plainDateDaysBetween(plannedFor, today),
            cost: row.cost,
          },
        }),
      );
    }
  };
  appendPastDueExpenses();

  // 5. unclassified_expense — trade left at the catch-all "other" AND no
  // cost logged (costType itself stays a clean 3-value enum — no
  // "uncategorized" value added there).
  items.push(
    ...unclassifiedExpenseRows.map((row) =>
      attentionItem({
        type: "unclassified_expense",
        severity: "info",
        name: row.name,
        entityType: "expense",
        entityId: row.shortcode,
        date: row.date,
        amount: null,
        href: `/expenses/${row.shortcode}`,
        facts: { date: row.date },
      }),
    ),
  );

  // 6. blocked_work — in_progress project with >=1 blocked task and zero
  // unblocked `next` tasks (no available next action).
  //
  // `actionable`'s tasks carry the public `projectId` (a shortcode); resolve
  // the ones in play back to the uuid this file's Sets/`inProjectScope` key
  // on, in ONE batched lookup rather than per-task.
  const appendBlockedProjects = async () => {
    const actionableProjectCodes = uniq(
      [
        ...actionable.next.map((row) => row.projectId),
        ...actionable.blocked.map((row) => row.task.projectId),
      ].filter((code): code is NonNullable<typeof code> => code != null),
    );
    const actionableProjectRefs = await resolveShortcodes(
      db,
      actionableProjectCodes,
    );
    const toProjectUuid = (code: string): ProjectId | null => {
      const ref = actionableProjectRefs.get(code);
      return ref?.entity === "project" ? ref.id : null;
    };
    const projectsWithNext = new Set<ProjectId>();
    for (const row of actionable.next) {
      const projectId = row.projectId ? toProjectUuid(row.projectId) : null;
      if (projectId && inProjectScope(projectId))
        projectsWithNext.add(projectId);
    }
    const blockedTaskCounts = new Map<ProjectId, number>();
    for (const row of actionable.blocked) {
      const projectId = row.task.projectId
        ? toProjectUuid(row.task.projectId)
        : null;
      if (projectId && inProjectScope(projectId)) {
        blockedTaskCounts.set(
          projectId,
          (blockedTaskCounts.get(projectId) ?? 0) + 1,
        );
      }
    }
    for (const row of inProgressProjectRows) {
      const blockedTasks = blockedTaskCounts.get(row.id) ?? 0;
      if (blockedTasks <= 0 || projectsWithNext.has(row.id)) continue;
      items.push(
        attentionItem({
          type: "blocked_work",
          severity: "warning",
          name: row.name,
          entityType: "project",
          entityId: row.shortcode,
          date: null,
          amount: null,
          href: `/projects/${row.shortcode}`,
          facts: { blockedTasks },
        }),
      );
    }
  };
  await appendBlockedProjects();

  // 7. date_window_drift — a manual startDate/endDate override that now hides
  // real derived work (own tasks/expenses, folded up through live
  // sub-projects). Checked independently per side against `row`'s raw
  // override columns (not `dates.effectiveStart/End`, which the override
  // itself determines) vs. the corresponding `derivedStart`/`derivedEnd`. A
  // WIDER override (e.g. a deliberate forward end date with nothing dated
  // out there yet) is intent, not drift, so only a too-narrow override
  // fires — and an override that exactly equals the derived bound doesn't
  // either.
  const appendDateWindowDrift = () => {
    for (const row of allProjectRows) {
      if (!projectInScope(row.id)) continue;
      const window = dateWindows.get(row.id);
      if (!window) continue;
      if (
        row.startDate != null &&
        window.derivedStart != null &&
        row.startDate > window.derivedStart
      ) {
        items.push(
          attentionItem({
            type: "date_window_drift",
            severity: "info",
            name: row.name,
            entityType: "project",
            entityId: row.shortcode,
            date: window.derivedStart,
            amount: null,
            href: `/projects/${row.shortcode}`,
            discriminator: "start",
            facts: {
              side: "start",
              override: row.startDate,
              derived: window.derivedStart,
              daysHidden: plainDateDaysBetween(
                window.derivedStart,
                row.startDate,
              ),
            },
          }),
        );
      }
      if (
        row.endDate != null &&
        window.derivedEnd != null &&
        row.endDate < window.derivedEnd
      ) {
        items.push(
          attentionItem({
            type: "date_window_drift",
            severity: "info",
            name: row.name,
            entityType: "project",
            entityId: row.shortcode,
            date: window.derivedEnd,
            amount: null,
            href: `/projects/${row.shortcode}`,
            discriminator: "end",
            facts: {
              side: "end",
              override: row.endDate,
              derived: window.derivedEnd,
              daysHidden: plainDateDaysBetween(row.endDate, window.derivedEnd),
            },
          }),
        );
      }
    }
  };
  appendDateWindowDrift();

  return items;
}
