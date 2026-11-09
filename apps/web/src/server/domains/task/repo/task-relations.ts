import { entityRefKey } from "@cubby/schemas/entity";
import {
  parseShortcodeFor,
  type TaskId,
  type TaskShortcode,
} from "@cubby/schemas/identifiers";
import { and, count, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { dependencyIdsFor } from "~/server/generic/entity-links/repo/dependency-edges";
import {
  type EntityRef,
  lookupShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

/**
 * Blocked-by / blocking id arrays for a set of tasks — thin wrapper over the
 * generic `dependencyIdsFor` (mirrors project/analytics.ts's
 * `projectDependencyIds`).
 */
export async function taskDependencyIds(
  db: Database,
  taskIds: TaskId[],
): Promise<{
  blockedBy: Map<TaskId, TaskShortcode[]>;
  blocking: Map<TaskId, TaskShortcode[]>;
}> {
  const raw = await dependencyIdsFor(db, "task", taskIds);

  // The edge VALUES (other tasks' ids) are resolved to shortcodes here, once,
  // batched — the task read takes
  // `blockedByIds`/`blockingIds` as public ids, and a uuid must never reach
  // that far. The KEYS stay the caller's own uuids (that's what every
  // `.get(row.id)` call site keys on).
  const allTaskIds = uniq(
    [...raw.blockedBy.values(), ...raw.blocking.values()].flat(),
  );
  const refs: EntityRef[] = allTaskIds.map((id) => ({ entity: "task", id }));
  const codes = await lookupShortcodes(db, refs);
  const toShortcodes = (ids: TaskId[]): TaskShortcode[] =>
    ids.map((id) => {
      const shortcode = codes.get(entityRefKey("task", id));
      if (!shortcode)
        throw new Error(`Task relation is missing shortcode for ${id}`);
      return parseShortcodeFor("task", shortcode);
    });

  return {
    blockedBy: new Map(
      [...raw.blockedBy].map(([id, ids]) => [id, toShortcodes(ids)]),
    ),
    blocking: new Map(
      [...raw.blocking].map(([id, ids]) => [id, toShortcodes(ids)]),
    ),
  };
}

/**
 * Live subtask counts (total + done) for a set of parent task ids — one
 * grouped query, batched like dependency and project rollups (never one query
 * per parent). Counts ALL live subtasks
 * including done ones, so callers whose row source already excludes done
 * tasks (e.g. actionable.ts's open-task fetch) still get the right totals.
 */
export async function taskSubtaskCounts(
  db: Database,
  parentIds: TaskId[],
): Promise<Map<TaskId, { count: number; doneCount: number }>> {
  const out = new Map<TaskId, { count: number; doneCount: number }>();
  if (parentIds.length === 0) return out;

  const rows = await getDb(db)
    .select({
      parentTaskId: task.parentTaskId,
      count: count(),
      doneCount: sql<number>`count(*) filter (where ${task.status} = ${"done"})::int`,
    })
    .from(task)
    .where(and(inArray(task.parentTaskId, parentIds), notDeleted(task)))
    .groupBy(task.parentTaskId);

  for (const row of rows) {
    if (!row.parentTaskId) continue;
    out.set(row.parentTaskId, { count: row.count, doneCount: row.doneCount });
  }
  return out;
}
