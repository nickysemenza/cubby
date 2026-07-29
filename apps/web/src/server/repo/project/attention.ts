/**
 * Server-side "Needs Attention" detector for the Overview page — ports the
 * client-side computation from `app/projects/needs-attention.tsx` (overdue
 * tasks, stalled projects, missing budgets) and adds four more rule types:
 * past-due planned purchases, unclassified purchases, blocked work with no
 * unblocked next task, and date-window drift (a manual override that now
 * hides real derived work). See `projectAttentionTypeSchema` in
 * packages/schemas/src/project.ts for the full rule enum.
 *
 * Computed GLOBALLY (not scoped to the dashboard's current filter set) — the
 * old `project.dashboard` this replaces had no filters at all, and scoping
 * `missing_budget` to an arbitrary partial project set would require
 * re-deriving subtree totals against a filter-inconsistent tree (a matched
 * parent's unmatched child still needs to count toward its subtree spend).
 * Simpler and more correct to always compute over every live project/task/
 * purchase; `dashboard-summary.ts` calls this once, unfiltered.
 *
 * Because that scope is the WHOLE tree, the caller's own whole-tree load is
 * the identical query set — hence the optional `preloaded` argument (see
 * `loadProjectSubtreeRollups`). `projectDashboardSummary` passes its bundle
 * in; `problems.service.ts` calls this standalone and lets it load its own.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { householdDaysAgo, householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { project, purchase, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { listActionableTasks } from "~/server/repo/task/actionable";
import {
  loadProjectSubtreeRollups,
  type ProjectSubtreeRollups,
} from "./subtree";

/** `stalled_project`'s no-activity window. */
const STALE_ACTIVITY_DAYS = 30;

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
  /** A whole-tree `loadProjectSubtreeRollups(db)` the caller already has. */
  preloaded?: ProjectSubtreeRollups,
): Promise<ProjectAttentionItem[]> {
  const today = householdLocalDate();
  const activityCutoff = householdDaysAgo(STALE_ACTIVITY_DAYS);
  const items: ProjectAttentionItem[] = [];

  const [
    overdueTaskRows,
    inProgressProjectRows,
    { allRows: allProjectRows, subtreeRollups, dateWindows },
    pastDuePurchaseRows,
    unclassifiedPurchaseRows,
    actionable,
  ] = await Promise.all([
    getDb(db)
      .select({
        id: task.id,
        name: task.name,
        dueDate: task.dueDate,
        dueEndDate: task.dueEndDate,
      })
      .from(task)
      .where(
        and(
          notDeleted(task),
          ne(task.status, "done"),
          isNull(task.parentTaskId),
        ),
      ),
    getDb(db)
      .select({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .where(and(notDeleted(project), eq(project.status, "in_progress"))),
    preloaded ?? loadProjectSubtreeRollups(db),
    getDb(db)
      .select({ id: purchase.id, name: purchase.name, date: purchase.date })
      .from(purchase)
      .where(
        and(
          notDeleted(purchase),
          eq(purchase.future, true),
          isNotNull(purchase.date),
          lt(purchase.date, today),
        ),
      ),
    getDb(db)
      .select({ id: purchase.id, name: purchase.name, date: purchase.date })
      .from(purchase)
      .where(
        and(
          notDeleted(purchase),
          eq(purchase.trade, "other"),
          isNull(purchase.cost),
        ),
      ),
    listActionableTasks(db),
  ]);

  // 1. overdue_task — one item per open top-level task past its effective
  // due date (`dueEndDate ?? dueDate`), matching needs-attention.tsx's
  // per-task granularity (not aggregated per project).
  for (const row of overdueTaskRows) {
    const effectiveDue = row.dueEndDate ?? row.dueDate;
    if (!effectiveDue || effectiveDue >= today) continue;
    items.push({
      key: attentionKey("overdue_task", row.id),
      type: "overdue_task",
      severity: "critical",
      description: `"${row.name}" was due ${effectiveDue} and is still open`,
      entityType: "task",
      entityId: row.id,
      date: effectiveDue,
      amount: null,
      href: `/tasks/${row.id}`,
    });
  }

  // 2. stalled_project — in_progress project with no project/task/purchase
  // `updatedAt` in the last 30 days. (Note/image activity isn't included —
  // no cheap existing "last activity" timestamp for those; see module doc.)
  const inProgressIds = inProgressProjectRows.map((r) => r.id);
  const [taskActivityRows, purchaseActivityRows] = await Promise.all([
    inProgressIds.length > 0
      ? getDb(db)
          .select({
            projectId: task.projectId,
            lastActivity: sql<Date>`max(${task.updatedAt})`,
          })
          .from(task)
          .where(and(inArray(task.projectId, inProgressIds), notDeleted(task)))
          .groupBy(task.projectId)
      : Promise.resolve([]),
    inProgressIds.length > 0
      ? getDb(db)
          .select({
            projectId: purchase.projectId,
            lastActivity: sql<Date>`max(${purchase.updatedAt})`,
          })
          .from(purchase)
          .where(
            and(
              inArray(purchase.projectId, inProgressIds),
              notDeleted(purchase),
            ),
          )
          .groupBy(purchase.projectId)
      : Promise.resolve([]),
  ]);
  const taskActivityByProject = new Map<ProjectId, Date>();
  for (const row of taskActivityRows) {
    if (row.projectId)
      taskActivityByProject.set(row.projectId, row.lastActivity);
  }
  const purchaseActivityByProject = new Map<ProjectId, Date>();
  for (const row of purchaseActivityRows) {
    if (row.projectId)
      purchaseActivityByProject.set(row.projectId, row.lastActivity);
  }

  for (const row of inProgressProjectRows) {
    const candidates = [
      row.updatedAt,
      taskActivityByProject.get(row.id),
      purchaseActivityByProject.get(row.id),
    ].filter((d): d is Date => d != null);
    const lastActivity = candidates.reduce(
      (latest, d) => (d > latest ? d : latest),
      row.updatedAt,
    );
    const lastActivityDate = householdLocalDate(lastActivity);
    if (lastActivityDate >= activityCutoff) continue;
    items.push({
      key: attentionKey("stalled_project", row.id),
      type: "stalled_project",
      severity: "warning",
      description: `"${row.name}" has had no project, task, or purchase activity in ${STALE_ACTIVITY_DAYS}+ days`,
      entityType: "project",
      entityId: row.id,
      date: lastActivityDate,
      amount: null,
      href: `/projects/${row.id}`,
    });
  }

  // 3. missing_budget — subtree actual+committed spend > 0, subtree
  // costEstimate still null. Reuses the same batched rollup/aggregation the
  // project reads use — never re-derived here.
  for (const row of allProjectRows) {
    const subtree = subtreeRollups.get(row.id);
    if (!subtree) continue;
    const spend = subtree.actualSpent + subtree.committedSpent;
    if (spend > 0 && subtree.costEstimate === null) {
      items.push({
        key: attentionKey("missing_budget", row.id),
        type: "missing_budget",
        severity: "info",
        description: `"${row.name}" has $${spend.toFixed(0)} in spend but no budget estimate`,
        entityType: "project",
        entityId: row.id,
        date: null,
        amount: spend,
        href: `/projects/${row.id}`,
      });
    }
  }

  // 4. past_due_planned_purchase
  for (const row of pastDuePurchaseRows) {
    items.push({
      key: attentionKey("past_due_planned_purchase", row.id),
      type: "past_due_planned_purchase",
      severity: "warning",
      description: `"${row.name}" was planned for ${row.date} but hasn't been logged as spent`,
      entityType: "purchase",
      entityId: row.id,
      date: row.date,
      amount: null,
      href: `/purchases/${row.id}`,
    });
  }

  // 5. unclassified_purchase — trade left at the catch-all "other" AND no
  // cost logged (costType itself stays a clean 3-value enum — no
  // "uncategorized" value added there).
  for (const row of unclassifiedPurchaseRows) {
    items.push({
      key: attentionKey("unclassified_purchase", row.id),
      type: "unclassified_purchase",
      severity: "info",
      description: `"${row.name}" has no trade or cost recorded`,
      entityType: "purchase",
      entityId: row.id,
      date: row.date,
      amount: null,
      href: `/purchases/${row.id}`,
    });
  }

  // 6. blocked_work — in_progress project with >=1 blocked task and zero
  // unblocked `next` tasks (no available next action).
  const projectsWithNext = new Set<ProjectId>();
  for (const t of actionable.next) {
    if (t.projectId) projectsWithNext.add(t.projectId);
  }
  const projectsWithBlocked = new Set<ProjectId>();
  for (const b of actionable.blocked) {
    if (b.task.projectId) projectsWithBlocked.add(b.task.projectId);
  }
  for (const row of inProgressProjectRows) {
    if (projectsWithBlocked.has(row.id) && !projectsWithNext.has(row.id)) {
      items.push({
        key: attentionKey("blocked_work", row.id),
        type: "blocked_work",
        severity: "warning",
        description: `"${row.name}" has blocked tasks and no unblocked next action`,
        entityType: "project",
        entityId: row.id,
        date: null,
        amount: null,
        href: `/projects/${row.id}`,
      });
    }
  }

  // 7. date_window_drift — a manual startDate/endDate override that now hides
  // real derived work (own tasks/purchases, folded up through live
  // sub-projects). Checked independently per side against `row`'s raw
  // override columns (not `dates.effectiveStart/End`, which the override
  // itself determines) vs. the corresponding `derivedStart`/`derivedEnd`. A
  // WIDER override (e.g. a deliberate forward end date with nothing dated
  // out there yet) is intent, not drift, so only a too-narrow override
  // fires — and an override that exactly equals the derived bound doesn't
  // either.
  for (const row of allProjectRows) {
    const window = dateWindows.get(row.id);
    if (!window) continue;
    if (
      row.startDate != null &&
      window.derivedStart != null &&
      row.startDate > window.derivedStart
    ) {
      items.push({
        key: attentionKey("date_window_drift", row.id, "start"),
        type: "date_window_drift",
        severity: "info",
        description: `Start date ${row.startDate} is after the earliest dated work (${window.derivedStart})`,
        entityType: "project",
        entityId: row.id,
        date: window.derivedStart,
        amount: null,
        href: `/projects/${row.id}`,
      });
    }
    if (
      row.endDate != null &&
      window.derivedEnd != null &&
      row.endDate < window.derivedEnd
    ) {
      items.push({
        key: attentionKey("date_window_drift", row.id, "end"),
        type: "date_window_drift",
        severity: "info",
        description: `End date ${row.endDate} is before the latest dated work (${window.derivedEnd})`,
        entityType: "project",
        entityId: row.id,
        date: window.derivedEnd,
        amount: null,
        href: `/projects/${row.id}`,
      });
    }
  }

  return items;
}
