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
import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "~/server/db";
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

const taskReader = createEntityReader({
  entityName: "task",
  fetchById: fetchTaskWithProject,
  fromDB: async (db, row) => {
    const deps = await taskDependencyIds(db, [row.id]);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
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
    const created = await insertAndReturn(tx, task, {
      name: data.name,
      status: data.status,
      projectId: data.projectId,
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
    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      projectId: data.projectId,
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

/** Soft-delete tasks, always hard-deleting their dependency edges in both directions first. */
export const deleteTasks = async (
  db: Database,
  ids: TaskId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, task, ids, "Task");

    await tx
      .delete(taskDependency)
      .where(
        or(
          inArray(taskDependency.taskId, ids),
          inArray(taskDependency.blockedByTaskId, ids),
        ),
      );

    const now = new Date();
    await tx
      .update(task)
      .set({ deletedAt: now })
      .where(and(inArray(task.id, ids), notDeleted(task)));

    await logAuditEntries(
      tx,
      actor,
      ids.map((id) => ({
        entityType: "task" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};
