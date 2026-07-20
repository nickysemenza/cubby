/**
 * Task CRUD operations.
 *
 * Mirrors project/crud.ts's shape: the read path goes through
 * `createEntityReader`, the write path is hand-rolled so `update` can manage
 * the `blockedByIds` replacement set (delete-then-insert `taskDependency`
 * rows) inside the same transaction as the column update.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { TaskId } from "@cubby/schemas/identifiers";
import type {
  TaskCreateInput,
  TaskOut,
  TaskUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { task, taskDependency } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  dependencyIdsFor,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { dbTaskToAPI } from "./helpers";

/** `taskUpdateData` has no standalone type export — derive it from the input. */
type TaskUpdateData = TaskUpdateInput["data"];

/** Plain (no relations) row fetch — used for the update-path before/after diff. */
const fetchTaskRow = (db: Database, id: TaskId) =>
  getDb(db).query.task.findFirst({
    where: and(eq(task.id, id), notDeleted(task)),
  });

/** Row fetch joined to the parent project's name — used for the public reader. */
const fetchTaskWithProject = (db: Database, id: TaskId) =>
  getDb(db).query.task.findFirst({
    where: and(eq(task.id, id), notDeleted(task)),
    ...relations.task.withProject,
  });

/**
 * Blocked-by / blocking id arrays for a set of tasks — thin wrapper over the
 * generic `dependencyIdsFor` (mirrors project/analytics.ts's
 * `projectDependencyIds`). Kept as a named export since it's consumed by name
 * elsewhere (this file's reader, task/lookup.ts's list).
 */
export async function taskDependencyIds(
  db: Database,
  taskIds: TaskId[],
): Promise<{
  blockedBy: Map<TaskId, TaskId[]>;
  blocking: Map<TaskId, TaskId[]>;
}> {
  return dependencyIdsFor(
    db,
    taskDependency,
    {
      ownColumn: taskDependency.taskId,
      blockedByColumn: taskDependency.blockedByTaskId,
    },
    taskIds,
  );
}

/**
 * Live subtask counts (total + done) for a set of parent task ids — one
 * grouped query, batched exactly like `taskDependencyIds`/`projectRollups`'
 * task rollup (never one query per parent). Counts ALL live subtasks
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
      count: sql<number>`count(*)::int`,
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

/**
 * One-level subtask validation, shared by create/update:
 *   - the chosen parent must exist and be live (TASK_NOT_FOUND otherwise)
 *   - the chosen parent must not itself be a subtask (TASK_PARENT_IS_SUBTASK)
 * Returns the parent's row (id/projectId/parentTaskId) so createTask can
 * inherit `projectId`.
 */
async function validateParentTask(
  tx: DrizzleTransaction,
  parentId: TaskId,
): Promise<{
  id: TaskId;
  projectId: TaskOut["projectId"];
  parentTaskId: TaskOut["parentTaskId"];
}> {
  const parent = await tx.query.task.findFirst({
    where: and(eq(task.id, parentId), notDeleted(task)),
    columns: { id: true, projectId: true, parentTaskId: true },
  });
  if (!parent) {
    throw createAppError("TASK_NOT_FOUND", `Parent task ${parentId} not found`);
  }
  if (parent.parentTaskId) {
    throw createAppError(
      "TASK_PARENT_IS_SUBTASK",
      `Task ${parentId} is itself a subtask — only one level of subtasks is supported.`,
    );
  }
  return parent;
}

/** Reject giving a parent to a task that already has live subtasks of its own. */
async function assertNoLiveSubtasks(
  tx: DrizzleTransaction,
  id: TaskId,
): Promise<void> {
  const subtasks = await tx.query.task.findMany({
    where: and(eq(task.parentTaskId, id), notDeleted(task)),
    columns: { id: true },
  });
  if (subtasks.length > 0) {
    throw createAppError(
      "TASK_HAS_SUBTASKS",
      `Task ${id} has ${subtasks.length} subtask(s) — a task with subtasks cannot itself become a subtask.`,
    );
  }
}

const taskReader = createEntityReader({
  entityName: "task",
  fetchById: fetchTaskWithProject,
  fromDB: async (db, row) => {
    const [deps, subtaskCounts] = await Promise.all([
      taskDependencyIds(db, [row.id]),
      taskSubtaskCounts(db, [row.id]),
    ]);
    const counts = subtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  },
  notFoundReason: "TASK_NOT_FOUND",
});

export const getTaskByID = (db: Database, id: TaskId): Promise<TaskOut> =>
  taskReader.getByID(db, id);

export const createTask = async (
  db: Database,
  data: TaskCreateInput,
  actor: ActorContext,
): Promise<TaskOut> => {
  const id = await withTransaction(db, async (tx) => {
    // `projectId` and `parentTaskId` both default to null through zod (see
    // taskCreateShape), so the repo can't tell "omitted" from "explicitly
    // null" — a null projectId alongside a parentTaskId is treated as
    // "inherit the parent's project", which covers both cases and lets an
    // explicit non-null projectId still win.
    let projectId = data.projectId;
    if (data.parentTaskId) {
      const parent = await validateParentTask(tx, data.parentTaskId);
      if (projectId == null) {
        projectId = parent.projectId;
      }
    }

    const created = await insertAndReturn(tx, task, {
      name: data.name,
      status: data.status,
      projectId,
      parentTaskId: data.parentTaskId,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
      category: data.category,
    });
    await logAuditEntry(tx, actor, {
      entityType: "task",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return getTaskByID(db, id);
};

const AUDIT_FIELDS = [
  "name",
  "status",
  "projectId",
  "parentTaskId",
  "dueDate",
  "dueEndDate",
  "category",
] as const;

export const updateTask = async (
  db: Database,
  id: TaskId,
  data: TaskUpdateData,
  actor: ActorContext,
): Promise<TaskOut> => {
  const before = await fetchTaskRow(db, id);
  if (!before) {
    throw createAppError("TASK_NOT_FOUND", `Task ${id} not found`);
  }
  const beforeBlockedBy =
    data.blockedByIds !== undefined
      ? ((await taskDependencyIds(db, [id])).blockedBy.get(id) ?? [])
      : undefined;

  await withTransaction(db, async (tx) => {
    if (data.parentTaskId !== undefined && data.parentTaskId !== null) {
      if (data.parentTaskId === id) {
        throw createAppError(
          "SELF_DEPENDENCY",
          "A task cannot be its own parent.",
        );
      }
      await validateParentTask(tx, data.parentTaskId);
      await assertNoLiveSubtasks(tx, id);
    }

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      projectId: data.projectId,
      parentTaskId: data.parentTaskId,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
      category: data.category,
    });
    const updated = await updateLiveAndReturn(tx, task, updateValues, id);

    if (data.blockedByIds !== undefined) {
      await replaceDependencyEdges(
        tx,
        taskDependency,
        {
          ownColumn: taskDependency.taskId,
          blockedByColumn: taskDependency.blockedByTaskId,
          buildRow: (taskIdVal, blockedByTaskId) => ({
            taskId: taskIdVal,
            blockedByTaskId,
          }),
          entityTable: task,
          label: "Task",
          notFoundReason: "TASK_NOT_FOUND",
        },
        id,
        data.blockedByIds,
      );
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {
      ...(computeChanges(before, updated, [...AUDIT_FIELDS]) ?? {}),
    };
    if (data.blockedByIds !== undefined) {
      const blockedByChange = diffUnorderedIdSet(
        beforeBlockedBy ?? [],
        data.blockedByIds,
      );
      if (blockedByChange) {
        changes.blockedByIds = blockedByChange;
      }
    }
    if (Object.keys(changes).length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "task",
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  return getTaskByID(db, id);
};

/**
 * Soft-delete tasks. One-level cascade: a deleted task's live subtasks have
 * no independent existence (they're checklist items represented via their
 * parent), so they're soft-deleted alongside it — same dependency-edge
 * hard-delete, audit, and embedding cleanup as the explicitly-requested ids.
 */
export const deleteTasks = async (
  db: Database,
  ids: TaskId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, task, ids, "Task");

    const liveSubtasks = await tx.query.task.findMany({
      where: and(inArray(task.parentTaskId, ids), notDeleted(task)),
      columns: { id: true },
    });
    const allIds = [...ids, ...liveSubtasks.map((t) => t.id)];

    await tx
      .delete(taskDependency)
      .where(
        or(
          inArray(taskDependency.taskId, allIds),
          inArray(taskDependency.blockedByTaskId, allIds),
        ),
      );

    const now = new Date();
    await tx
      .update(task)
      .set({ deletedAt: now })
      .where(and(inArray(task.id, allIds), notDeleted(task)));

    // Removal-path invariant: every delete path cleans up its embeddings in-tx.
    await softDeleteEntityEmbeddingsTx(tx, "task", allIds);

    await logAuditEntries(
      tx,
      actor,
      allIds.map((id) => ({
        entityType: "task" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};
