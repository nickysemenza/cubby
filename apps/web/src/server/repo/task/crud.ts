/**
 * Task CRUD operations.
 *
 * Mirrors project/crud.ts's shape: the read path goes through
 * `createEntityReader`, the write path is hand-rolled so `update` can manage
 * the `blockedByIds` replacement set (delete-then-insert `taskDependency`
 * rows) inside the same transaction as the column update.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { ProductId, TaskId } from "@cubby/schemas/identifiers";
import type {
  TaskBulkDueDateInput,
  TaskBulkMoveInput,
  TaskBulkReorderInput,
  TaskBulkStatusInput,
  TaskBulkTradeInput,
  TaskCreateInput,
  TaskOut,
  TaskUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { product, task, taskDependency } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  batchUpdateWithCaseWhen,
  buildPartialUpdateValues,
  dependencyIdsFor,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { assertProjectLive } from "~/server/repo/project";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { dbTaskToAPI } from "./helpers";

export const TASK_DELETE_EDGE_POLICY = {
  "Task.parentTaskId": {
    code: "cascade-live-child",
    effect: "soft-delete",
    description:
      "A deleted task's live subtasks are soft-deleted alongside it — they're checklist items with no independent existence.",
  },
  "TaskDependency.taskId": {
    code: "hard-delete-dependency",
    effect: "hard-delete",
    description:
      "Blocks/blocked-by dependency rows naming the task (or a cascaded subtask) are removed outright.",
  },
  "TaskDependency.blockedByTaskId": {
    code: "hard-delete-dependency",
    effect: "hard-delete",
    description:
      "Blocks/blocked-by dependency rows naming the task (or a cascaded subtask) are removed outright.",
  },
} as const satisfies IncomingEdgePolicy<"task", OperationDisposition>;

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
  subjectProductId: TaskOut["subjectProductId"];
  parentTaskId: TaskOut["parentTaskId"];
}> {
  const parent = await tx.query.task.findFirst({
    where: and(eq(task.id, parentId), notDeleted(task)),
    columns: {
      id: true,
      projectId: true,
      subjectProductId: true,
      parentTaskId: true,
    },
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

/** A task can only target a live product; stale picker/API ids fail clearly. */
async function assertSubjectProductLive(
  tx: DrizzleTransaction,
  id: ProductId,
): Promise<void> {
  const subject = await tx.query.product.findFirst({
    where: and(eq(product.id, id), notDeleted(product)),
    columns: { id: true },
  });
  if (!subject) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }
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
  entity: "task",
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

export const getTaskByShortcode = (db: Database, shortcode: string) =>
  taskReader.getByShortcode(db, shortcode);

/**
 * Batch by-id read for bulk-write results (`moveTasks`/`setTasksStatus`) — the
 * same row shape/joins as `getTaskByID`, fetched with one `inArray` query plus
 * the batched dependency/subtask-count reads instead of N one-by-one calls.
 * Exported for `repo/project/create-from-tasks.ts`'s promotion read-back
 * (its moved-task ids need the same batched shape, not N `getTaskByID` calls).
 */
export const getTasksByIDs = async (
  db: Database,
  ids: TaskId[],
): Promise<TaskOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.task.findMany({
    where: and(inArray(task.id, ids), notDeleted(task)),
    ...relations.task.withProject,
  });
  const [deps, subtaskCounts] = await Promise.all([
    taskDependencyIds(db, ids),
    taskSubtaskCounts(db, ids),
  ]);
  return rows.map((row) => {
    const counts = subtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  });
};

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
    let subjectProductId = data.subjectProductId;
    if (data.parentTaskId) {
      const parent = await validateParentTask(tx, data.parentTaskId);
      if (projectId == null) {
        projectId = parent.projectId;
      }
      if (subjectProductId == null) {
        subjectProductId = parent.subjectProductId;
      }
    }
    if (subjectProductId) {
      await assertSubjectProductLive(tx, subjectProductId);
    }

    const created = await insertWithShortcode(tx, "task", {
      name: data.name,
      status: data.status,
      projectId,
      subjectProductId,
      parentTaskId: data.parentTaskId,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
      trade: data.trade,
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
  "subjectProductId",
  "parentTaskId",
  "dueDate",
  "dueEndDate",
  "trade",
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
    if (data.subjectProductId) {
      await assertSubjectProductLive(tx, data.subjectProductId);
    }

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      projectId: data.projectId,
      subjectProductId: data.subjectProductId,
      parentTaskId: data.parentTaskId,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
      trade: data.trade,
      sortOrder: data.sortOrder,
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
 * Bulk "move to project" — a plain `projectId` column write over `ids`, one
 * transaction, one audit entry per row that actually changed. `projectId:
 * null` moves every listed task to the inbox. Unlike the single-row
 * `updateTask` there's no before/after row diff to lean on for validation, so
 * the target project's liveness is checked explicitly (`assertProjectLive`) —
 * the UI's project picker already filters to live projects, but the tRPC API
 * is callable directly.
 */
export const moveTasks = async (
  db: Database,
  input: TaskBulkMoveInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ids, projectId } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    if (projectId !== null) {
      await assertProjectLive(tx, projectId);
    }

    const before = await tx.query.task.findMany({
      where: and(inArray(task.id, ids), notDeleted(task)),
      columns: { id: true, projectId: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(task)
      .set({ projectId })
      .where(and(inArray(task.id, ids), notDeleted(task)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, projectId }, [
        "projectId",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "task",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/**
 * Bulk status write — a plain `status` column write over `ids`, mirroring
 * `moveTasks`'s shape. A plain UPDATE with no recurrence/denormalization
 * side-effects, same as `updateTask`'s status write — there's no "done"
 * cascade in this schema today.
 */
export const setTasksStatus = async (
  db: Database,
  input: TaskBulkStatusInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ids, status } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const before = await tx.query.task.findMany({
      where: and(inArray(task.id, ids), notDeleted(task)),
      columns: { id: true, status: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(task)
      .set({ status })
      .where(and(inArray(task.id, ids), notDeleted(task)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, status }, ["status"]);
      if (changes) {
        auditEntries.push({
          entityType: "task",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/**
 * Bulk trade write — a plain `trade` column write over `ids`, mirroring
 * `setTasksStatus`. A trade change is embedding-relevant, but (like the other
 * bulk writes here) the router runs one wave-wide side-effect dispatch, so
 * this stays a plain audited UPDATE.
 */
export const setTasksTrade = async (
  db: Database,
  input: TaskBulkTradeInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ids, trade } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const before = await tx.query.task.findMany({
      where: and(inArray(task.id, ids), notDeleted(task)),
      columns: { id: true, trade: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(task)
      .set({ trade })
      .where(and(inArray(task.id, ids), notDeleted(task)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, trade }, ["trade"]);
      if (changes) {
        auditEntries.push({
          entityType: "task",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/**
 * Bulk due-date write — a plain `dueDate`/`dueEndDate` column pair write over
 * `ids`, mirroring `setTasksStatus`/`setTasksTrade`.
 */
export const setTasksDueDate = async (
  db: Database,
  input: TaskBulkDueDateInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ids, dueDate, dueEndDate } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const before = await tx.query.task.findMany({
      where: and(inArray(task.id, ids), notDeleted(task)),
      columns: { id: true, dueDate: true, dueEndDate: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(task)
      .set({ dueDate, dueEndDate })
      .where(and(inArray(task.id, ids), notDeleted(task)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, dueDate, dueEndDate }, [
        "dueDate",
        "dueEndDate",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "task",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/**
 * Bulk manual-reorder — the board's "materialize" path. Re-assigns sparse
 * `sortOrder` values to a run of cards (one CASE-WHEN UPDATE via
 * {@link batchUpdateWithCaseWhen}) and, when the drop also crossed cells,
 * applies the dragged card's own axis change (`move`) in the same transaction.
 *
 * The rank write is deliberately un-audited — manual priority is ephemeral and
 * a materialize touches many rows; only the `move`'s axis change (if any) is
 * logged, mirroring `updateTask`'s status/project/trade diff.
 */
export const reorderTasks = async (
  db: Database,
  input: TaskBulkReorderInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ranks, move } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    if (move != null && move.patch.projectId != null) {
      await assertProjectLive(tx, move.patch.projectId);
    }

    // Every ranked id maps to its own new sortOrder — a single CASE-WHEN
    // UPDATE, not one round-trip per card. STEP-spaced integers, so the
    // helper's `::real` cast is lossless here (fine-grained midpoint writes go
    // through the single-update path in updateTask, which keeps full double
    // precision).
    await batchUpdateWithCaseWhen(
      tx,
      task,
      ranks.map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
    );

    if (move != null) {
      const axisValues = buildPartialUpdateValues({
        status: move.patch.status,
        projectId: move.patch.projectId,
        trade: move.patch.trade,
      });
      if (Object.keys(axisValues).length > 0) {
        const before = await tx.query.task.findFirst({
          where: and(eq(task.id, move.id), notDeleted(task)),
        });
        const updated = await updateLiveAndReturn(
          tx,
          task,
          axisValues,
          move.id,
        );
        const changes = before
          ? computeChanges(before, updated, ["status", "projectId", "trade"])
          : undefined;
        if (changes) {
          await logAuditEntry(tx, actor, {
            entityType: "task",
            entityId: move.id,
            action: "update",
            changes,
          });
        }
      }
    }

    return ranks.map((r) => r.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/** Either a checked-out transaction or a plain client — reads work the same on both. */
type TaskQueryClient = DrizzleClient | DrizzleTransaction;

/**
 * Live subtasks of `ids`, carrying both `id` (for `deleteTasks`' one-level
 * cascade expansion) and `parentTaskId` (for `previewDeleteTasks`' per-parent
 * count). Shared so the two can't disagree on which rows cascade.
 */
const fetchLiveSubtasks = (dbc: TaskQueryClient, ids: TaskId[]) =>
  dbc.query.task.findMany({
    where: and(inArray(task.parentTaskId, ids), notDeleted(task)),
    columns: { id: true, parentTaskId: true },
  });

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

    const liveSubtasks = await fetchLiveSubtasks(tx, ids);
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

/**
 * What `deleteTasks` would do to the given tasks, without doing it.
 *
 * Reads the SAME `TASK_DELETE_EDGE_POLICY` and the same `fetchLiveSubtasks`
 * predicate the mutation's one-level cascade uses, so the preview's cascade
 * expansion can't drift from the mutation's. `TaskDependency`'s two edges are
 * counted over `allIds` (the requested ids plus their live subtasks) with
 * `includeDeleted: true` — it's one of the two hard-delete-only source tables
 * in the schema (no `deletedAt` column), so the default `notDeleted` filter
 * would throw. There are no blockers: `TASK_DELETE_EDGE_POLICY` has none, and
 * a task delete is never refused, only performed.
 *
 * Advisory only. `deleteTasks` still re-runs the same cascade inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteTasks = async (
  db: Database,
  ids: TaskId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const dbClient = getDb(db);

  const liveSubtasks = await fetchLiveSubtasks(dbClient, ids);
  const allIds = [...ids, ...liveSubtasks.map((t) => t.id)];

  const subtasksByTarget: Record<string, number> = {};
  for (const { parentTaskId } of liveSubtasks) {
    if (parentTaskId) {
      subtasksByTarget[parentTaskId] =
        (subtasksByTarget[parentTaskId] ?? 0) + 1;
    }
  }

  const changes = present([
    impact({
      disposition: TASK_DELETE_EDGE_POLICY["Task.parentTaskId"],
      edgeKey: "Task.parentTaskId",
      label: "subtasks",
      byTargetId: subtasksByTarget,
    }),
    impact({
      disposition: TASK_DELETE_EDGE_POLICY["TaskDependency.taskId"],
      edgeKey: "TaskDependency.taskId",
      label: "dependency edges (blocking others)",
      byTargetId: await countByTarget(
        dbClient,
        taskDependency,
        taskDependency.taskId,
        allIds,
        { includeDeleted: true },
      ),
    }),
    impact({
      disposition: TASK_DELETE_EDGE_POLICY["TaskDependency.blockedByTaskId"],
      edgeKey: "TaskDependency.blockedByTaskId",
      label: "dependency edges (blocked by others)",
      byTargetId: await countByTarget(
        dbClient,
        taskDependency,
        taskDependency.blockedByTaskId,
        allIds,
        { includeDeleted: true },
      ),
    }),
  ]);

  return { blockers: [], changes };
};
