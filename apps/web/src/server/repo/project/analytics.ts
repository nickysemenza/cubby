/**
 * Project analytics: batched cost/progress rollups and dependency-edge reads.
 *
 * Both `projectRollups` and `projectDependencyIds` take a *set* of project ids
 * and return a lookup keyed by id — one query per underlying relation (two for
 * the rollup: purchases + tasks; two for dependencies: blocked-by + blocking),
 * never one query per project. Callers (crud.ts's reader, lookup.ts's list)
 * always batch the ids of the page/row they're mapping, so a list of 50
 * projects costs 4 queries total, not 200.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type { ProjectRollup } from "@cubby/schemas/project";
import { and, inArray, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { projectDependency, purchase, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { EMPTY_PROJECT_ROLLUP } from "./helpers";

/**
 * SUM/COUNT rollups over live purchases and tasks, per project.
 *
 * `spent` sums ALL live purchases including `future` (not-yet-made) ones —
 * this matches the retired Notion rollup's semantics (a planned spend still
 * counts toward the running total against the estimate). See
 * packages/schemas/src/project.ts's `projectRollup` doc comment.
 */
export async function projectRollups(
  db: Database,
  projectIds: ProjectId[],
): Promise<Map<ProjectId, ProjectRollup>> {
  const out = new Map<ProjectId, ProjectRollup>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, { ...EMPTY_PROJECT_ROLLUP });

  const [purchaseRows, taskRows] = await Promise.all([
    getDb(db)
      .select({
        projectId: purchase.projectId,
        spent: sql<number>`coalesce(sum(${purchase.cost}), 0)::float`,
        purchaseCount: sql<number>`count(*)::int`,
      })
      .from(purchase)
      .where(and(inArray(purchase.projectId, projectIds), notDeleted(purchase)))
      .groupBy(purchase.projectId),
    getDb(db)
      .select({
        projectId: task.projectId,
        taskCount: sql<number>`count(*)::int`,
        doneTaskCount: sql<number>`count(*) filter (where ${task.status} = ${"done"})::int`,
      })
      .from(task)
      .where(and(inArray(task.projectId, projectIds), notDeleted(task)))
      .groupBy(task.projectId),
  ]);

  for (const row of purchaseRows) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? { ...EMPTY_PROJECT_ROLLUP };
    out.set(row.projectId, {
      ...existing,
      spent: row.spent,
      purchaseCount: row.purchaseCount,
    });
  }
  for (const row of taskRows) {
    if (!row.projectId) continue;
    const existing = out.get(row.projectId) ?? { ...EMPTY_PROJECT_ROLLUP };
    out.set(row.projectId, {
      ...existing,
      taskCount: row.taskCount,
      doneTaskCount: row.doneTaskCount,
    });
  }
  return out;
}

/**
 * Blocked-by / blocking id arrays for a set of projects. `projectDependency`
 * rows are directed edges (projectId is blocked by blockedByProjectId);
 * "blocking" is the reverse read of the same table — which projects does THIS
 * project block.
 */
export async function projectDependencyIds(
  db: Database,
  projectIds: ProjectId[],
): Promise<{
  blockedBy: Map<ProjectId, ProjectId[]>;
  blocking: Map<ProjectId, ProjectId[]>;
}> {
  const blockedBy = new Map<ProjectId, ProjectId[]>();
  const blocking = new Map<ProjectId, ProjectId[]>();
  if (projectIds.length === 0) return { blockedBy, blocking };

  const [blockedByRows, blockingRows] = await Promise.all([
    getDb(db)
      .select({
        projectId: projectDependency.projectId,
        blockedByProjectId: projectDependency.blockedByProjectId,
      })
      .from(projectDependency)
      .where(inArray(projectDependency.projectId, projectIds)),
    getDb(db)
      .select({
        projectId: projectDependency.projectId,
        blockedByProjectId: projectDependency.blockedByProjectId,
      })
      .from(projectDependency)
      .where(inArray(projectDependency.blockedByProjectId, projectIds)),
  ]);

  for (const row of blockedByRows) {
    const arr = blockedBy.get(row.projectId) ?? [];
    arr.push(row.blockedByProjectId);
    blockedBy.set(row.projectId, arr);
  }
  for (const row of blockingRows) {
    const arr = blocking.get(row.blockedByProjectId) ?? [];
    arr.push(row.projectId);
    blocking.set(row.blockedByProjectId, arr);
  }
  return { blockedBy, blocking };
}
