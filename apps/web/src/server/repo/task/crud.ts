/**
 * Task CRUD operations.
 *
 * Mirrors project/crud.ts's shape: the read path goes through
 * `createEntityReader`, the write path is hand-rolled so `update` can manage
 * the `blockedByIds` replacement set (delete-then-insert `taskDependency`
 * rows) inside the same transaction as the column update.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  ProductId,
  ProductShortcode,
  ProjectId,
  ProjectShortcode,
  TaskId,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  TaskBulkMoveInput,
  TaskBulkReorderInput,
  TaskBulkStatusInput,
  TaskCreateInput,
  TaskOut,
  TaskUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

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
import { patchEntityRows } from "~/server/repo/entity-patch";
import { removeEntity } from "~/server/repo/removal";
import {
  type EntityRef,
  lookupShortcodes,
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { dbTaskToAPI } from "./helpers";

type TaskUpdateAuditEntry = Exclude<AuditEntryInput, { action: "delete" }>;
type TaskUpdateChanges = NonNullable<TaskUpdateAuditEntry["changes"]>;

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

type TaskUpdateData = TaskUpdateInput["data"];

/** See MealMutationHooks: CalDAV compares a stale projection while this update
 * owns the canonical Task row lock. */
export type TaskMutationHooks = {
  beforeUpdate?: (tx: DrizzleTransaction, id: TaskId) => Promise<void>;
};

const fetchTaskRow = (db: Database, id: TaskId) =>
  getDb(db).query.task.findFirst({
    where: and(eq(task.id, id), notDeleted(task)),
  });

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
  blockedBy: Map<TaskId, TaskShortcode[]>;
  blocking: Map<TaskId, TaskShortcode[]>;
}> {
  const raw = await dependencyIdsFor(
    db,
    {
      ownColumn: taskDependency.taskId,
      blockedByColumn: taskDependency.blockedByTaskId,
      entity: "task",
    },
    taskIds,
  );

  // The edge VALUES (other tasks' ids) are resolved to shortcodes here, once,
  // batched — `dbTaskToAPI` (every consumer's eventual destination) takes
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
  projectId: ProjectId | null;
  subjectProductId: ProductId | null;
  parentTaskId: TaskId | null;
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

/** Resolve a public product shortcode to the live uuid stored in the task FK. */
function resolveSubjectProductId(
  tx: DrizzleTransaction,
  shortcode: ProductShortcode,
): Promise<ProductId> {
  return resolveOrThrow(tx, "product", shortcode);
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
});

const getTaskByID = (db: Database, id: TaskId): Promise<TaskOut> =>
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
): Promise<{ output: TaskOut; entityId: TaskId }> => {
  const id = await withTransaction(db, async (tx) => {
    // `projectId` and `parentTaskId` both default to null through zod (see
    // taskCreateShape), so the repo can't tell "omitted" from "explicitly
    // null" — a null projectId alongside a parentTaskId is treated as
    // "inherit the parent's project", which covers both cases and lets an
    // explicit non-null projectId still win. Both arrive as shortcodes;
    // resolving THROUGH a live-only lookup is the existence+liveness check.
    let parentTaskId: TaskId | null = null;
    if (data.parentTaskId) {
      parentTaskId = await resolveOrThrow(tx, "task", data.parentTaskId);
    }

    let projectId: ProjectId | null = null;
    if (data.projectId) {
      projectId = await resolveOrThrow(tx, "project", data.projectId);
    }
    let subjectProductId = data.subjectProductId
      ? await resolveSubjectProductId(tx, data.subjectProductId)
      : null;

    if (parentTaskId) {
      const parent = await validateParentTask(tx, parentTaskId);
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
      parentTaskId,
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
  return { output: await getTaskByID(db, id), entityId: id };
};

export const updateTask = async (
  db: Database,
  shortcode: TaskShortcode,
  data: TaskUpdateData,
  actor: ActorContext,
  hooks?: TaskMutationHooks,
): Promise<{ output: TaskOut; entityId: TaskId }> => {
  const id = await resolveOrThrow(db, "task", shortcode);

  const before = await fetchTaskRow(db, id);
  if (!before) {
    throw createAppError("TASK_NOT_FOUND", `Task ${id} not found`);
  }
  const beforeBlockedBy =
    data.blockedByIds !== undefined
      ? ((await taskDependencyIds(db, [id])).blockedBy.get(id) ?? [])
      : undefined;

  await withTransaction(db, async (tx) => {
    await hooks?.beforeUpdate?.(tx, id);
    let parentTaskId: TaskId | null | undefined;
    if (data.parentTaskId !== undefined && data.parentTaskId !== null) {
      if (data.parentTaskId === shortcode) {
        throw createAppError(
          "SELF_DEPENDENCY",
          "A task cannot be its own parent.",
        );
      }
      parentTaskId = await resolveOrThrow(tx, "task", data.parentTaskId);
      await validateParentTask(tx, parentTaskId);
      await assertNoLiveSubtasks(tx, id);
    } else if (data.parentTaskId === null) {
      parentTaskId = null;
    }

    let projectId: ProjectId | null | undefined;
    if (data.projectId !== undefined && data.projectId !== null) {
      projectId = await resolveOrThrow(tx, "project", data.projectId);
    } else if (data.projectId === null) {
      projectId = null;
    }

    const subjectProductId =
      data.subjectProductId === undefined
        ? undefined
        : data.subjectProductId === null
          ? null
          : await resolveSubjectProductId(tx, data.subjectProductId);

    // Full-replacement set: resolve every requested shortcode to a live uuid
    // up front — `replaceDependencyEdges`'s own not-found check operates on
    // the FK column, so it can't be handed a shortcode.
    let resolvedBlockedByIds: TaskId[] | undefined;
    if (data.blockedByIds !== undefined) {
      resolvedBlockedByIds = await resolveAllOrThrow(
        tx,
        "task",
        data.blockedByIds,
      );
    }

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      projectId,
      subjectProductId,
      parentTaskId,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
      trade: data.trade,
      sortOrder: data.sortOrder,
    });
    const updated = await updateLiveAndReturn(tx, task, updateValues, id);

    if (resolvedBlockedByIds !== undefined) {
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
          entity: "task",
        },
        id,
        resolvedBlockedByIds,
      );
    }

    const changes: TaskUpdateChanges = {
      ...computeChanges(before, updated, [...entityFieldModels.task.audit]),
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

  return { output: await getTaskByID(db, id), entityId: id };
};

/**
 * Resolve a bulk selection to live uuids, DROPPING codes that name nothing
 * live. Bulk writes are documented to skip a soft-deleted or unknown id rather
 * than reject the batch; use {@link resolveLiveTaskIdsOrThrow} where a specific
 * id is a precondition (the reorder anchor), not part of a set.
 */
const resolveLiveTaskIds = (
  tx: DrizzleTransaction,
  shortcodes: TaskShortcode[],
): Promise<TaskId[]> => resolveAllPresent(tx, "task", shortcodes);

const resolveLiveTaskIdsOrThrow = (
  tx: DrizzleTransaction,
  shortcodes: TaskShortcode[],
): Promise<TaskId[]> => resolveAllOrThrow(tx, "task", shortcodes);

const resolveLiveTaskProjectId = (
  tx: DrizzleTransaction,
  shortcode: ProjectShortcode,
): Promise<ProjectId> => resolveOrThrow(tx, "project", shortcode);

type TaskBulkPatch = Pick<
  TaskUpdateData,
  "projectId" | "status" | "trade" | "dueDate" | "dueEndDate"
>;

export const updateTasksInBulk = async (
  db: Database,
  shortcodes: TaskShortcode[],
  data: TaskBulkPatch,
  actor: ActorContext,
): Promise<{ updatedIds: TaskId[]; updatedShortcodes: TaskShortcode[] }> => {
  if (new Set(shortcodes).size !== shortcodes.length) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Bulk task IDs must be unique.",
    );
  }
  if (data.dueDate !== undefined || data.dueEndDate !== undefined) {
    if (data.dueDate === undefined || data.dueEndDate === undefined) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A bulk due-date patch must supply both dueDate and dueEndDate.",
      );
    }
  }

  const hasPatch =
    data.projectId !== undefined ||
    data.status !== undefined ||
    data.trade !== undefined ||
    data.dueDate !== undefined ||
    data.dueEndDate !== undefined;
  if (!hasPatch) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A bulk task patch must supply at least one field.",
    );
  }

  return await withTransaction(db, async (tx) => {
    const projectId =
      data.projectId === undefined
        ? undefined
        : data.projectId === null
          ? null
          : await resolveLiveTaskProjectId(tx, data.projectId);
    const ids = await resolveLiveTaskIdsOrThrow(tx, shortcodes);
    const before = await tx
      .select({
        id: task.id,
        shortcode: task.shortcode,
        projectId: task.projectId,
        status: task.status,
        trade: task.trade,
        dueDate: task.dueDate,
        dueEndDate: task.dueEndDate,
      })
      .from(task)
      .where(and(inArray(task.id, ids), notDeleted(task)))
      .for("update");
    if (before.length !== ids.length) {
      throw createAppError("TASK_NOT_FOUND", "One or more tasks are missing.");
    }

    const values = buildPartialUpdateValues({
      projectId,
      status: data.status,
      trade: data.trade,
      dueDate: data.dueDate,
      dueEndDate: data.dueEndDate,
    });
    await tx
      .update(task)
      .set(values)
      .where(and(inArray(task.id, ids), notDeleted(task)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { ...row, ...values }, [
        ...entityFieldModels.task.bulk,
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

    return {
      updatedIds: before.map((row) => row.id),
      updatedShortcodes: before.map((row) =>
        parseShortcodeFor("task", row.shortcode),
      ),
    };
  });
};

/**
 * Bulk "move to project" — a plain `projectId` column write over `ids`, one
 * transaction, one audit entry per row that actually changed. `projectId:
 * null` moves every listed task to the inbox. Unlike the single-row
 * `updateTask` there's no before/after row diff to lean on for validation, so
 * the target project's liveness is checked explicitly (`assertProjectLive`) —
 * the UI's project picker already filters to live projects, but the workflow API
 * is callable directly.
 */
export const moveTasks = async (
  db: Database,
  input: TaskBulkMoveInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const updatedIds = await withTransaction(db, async (tx) => {
    // Resolving THROUGH a live-only lookup is the liveness check itself.
    const projectId =
      input.projectId !== null
        ? await resolveLiveTaskProjectId(tx, input.projectId)
        : null;

    const ids = await resolveLiveTaskIds(tx, input.ids);

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
  const { status } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const ids = await resolveLiveTaskIds(tx, input.ids);
    if (ids.length === 0) return [];

    await patchEntityRows(
      tx,
      actor,
      {
        entity: "task",
        table: task,
        fields: entityFieldModels.task.bulk,
      },
      ids,
      { status },
    );
    // Preserve the convenience setter's all-live-selection result even when
    // patchEntityRows finds no changed rows.
    return ids;
  });

  return getTasksByIDs(db, updatedIds);
};

/** Rank writes are deliberately unaudited: materializing manual priority
 * touches many rows. Only the dragged card's axis change is audited, in the
 * same transaction as the rank update. */
export const reorderTasks = async (
  db: Database,
  input: TaskBulkReorderInput,
  actor: ActorContext,
): Promise<TaskOut[]> => {
  const { ranks, move } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const rankedIds = await resolveLiveTaskIdsOrThrow(
      tx,
      ranks.map((r) => r.id),
    );
    const resolvedRanks = ranks.map((r, i) => ({
      id: rankedIds[i]!,
      sortOrder: r.sortOrder,
    }));

    let moveId: TaskId | undefined;
    let movePatchProjectId: ProjectId | null | undefined;
    if (move != null) {
      moveId = (await resolveLiveTaskIdsOrThrow(tx, [move.id]))[0];
      if (move.patch.projectId != null) {
        movePatchProjectId = await resolveLiveTaskProjectId(
          tx,
          move.patch.projectId,
        );
      } else if (move.patch.projectId === null) {
        movePatchProjectId = null;
      }
    }

    // Every ranked id maps to its own new sortOrder — a single CASE-WHEN
    // UPDATE, not one round-trip per card. STEP-spaced integers, so the
    // helper's `::real` cast is lossless here (fine-grained midpoint writes go
    // through the single-update path in updateTask, which keeps full double
    // precision).
    await batchUpdateWithCaseWhen(tx, task, resolvedRanks);

    if (move != null && moveId != null) {
      const axisValues = buildPartialUpdateValues({
        status: move.patch.status,
        projectId: movePatchProjectId,
        trade: move.patch.trade,
      });
      if (Object.keys(axisValues).length > 0) {
        const before = await tx.query.task.findFirst({
          where: and(eq(task.id, moveId), notDeleted(task)),
        });
        const updated = await updateLiveAndReturn(tx, task, axisValues, moveId);
        const changes = before
          ? computeChanges(before, updated, ["status", "projectId", "trade"])
          : undefined;
        if (changes) {
          await logAuditEntry(tx, actor, {
            entityType: "task",
            entityId: moveId,
            action: "update",
            changes,
          });
        }
      }
    }

    return resolvedRanks.map((r) => r.id);
  });

  return getTasksByIDs(db, updatedIds);
};

/** Either a checked-out transaction or a plain client — reads work the same on both. */
type TaskQueryClient = DrizzleClient | DrizzleTransaction;

/**
 * Live subtasks of `ids`, carrying both `id` and `parentTaskId` for
 * `deleteTasks`' one-level cascade expansion.
 */
const fetchLiveSubtasks = (dbc: TaskQueryClient, ids: TaskId[]) =>
  dbc.query.task.findMany({
    where: and(inArray(task.parentTaskId, ids), notDeleted(task)),
    columns: { id: true, shortcode: true, parentTaskId: true },
  });

/**
 * Soft-delete tasks. One-level cascade: a deleted task's live subtasks have
 * no independent existence (they're checklist items represented via their
 * parent), so they're soft-deleted alongside it — same dependency-edge
 * hard-delete, audit, and embedding cleanup as the explicitly-requested ids.
 */
export const deleteTasks = async (
  db: Database,
  shortcodes: TaskShortcode[],
  actor: ActorContext,
): Promise<{ deletedShortcodes: TaskShortcode[] }> => {
  if (shortcodes.length === 0) return { deletedShortcodes: [] };

  return await withTransaction(db, async (tx) => {
    const ids = await resolveLiveTaskIdsOrThrow(tx, shortcodes);
    await lockAndValidateForDelete(tx, task, ids, "Task");

    const liveSubtasks = await fetchLiveSubtasks(tx, ids);
    const explicitlyDeletedIds = new Set(ids);
    const cascadedSubtasks = liveSubtasks.filter(
      (subtask) => !explicitlyDeletedIds.has(subtask.id),
    );
    const allIds = [...ids, ...cascadedSubtasks.map((subtask) => subtask.id)];

    // Over `allIds`, not `ids`: the cascaded subtasks are removals too. Their
    // public shortcodes are returned below so callers report what was actually
    // deleted rather than projecting the request into an incomplete result.
    await removeEntity(tx, {
      entity: "task",
      ids: allIds,
      removal: "soft",
      actor,
      children: [
        // Both ends: a dependency edge carries no meaning once either endpoint
        // is gone, so it is hard-deleted rather than soft-deleted.
        {
          table: taskDependency,
          parentColumns: [
            taskDependency.taskId,
            taskDependency.blockedByTaskId,
          ],
          mode: "hard",
        },
      ],
    });
    return {
      deletedShortcodes: [
        ...shortcodes,
        ...cascadedSubtasks.map((row) =>
          parseShortcodeFor("task", row.shortcode),
        ),
      ],
    };
  });
};
