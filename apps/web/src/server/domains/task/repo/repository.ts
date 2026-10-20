import { getDb } from "~/server/db/helpers";
import { refreshDerivedSearchRefs } from "~/server/entity-kernel/repo/mutation-side-effects";
import {
  asActor,
  defineRepository,
  onDb,
} from "~/server/entity-kernel/repo/repository";

import {
  createTask,
  createTaskRead,
  deleteTasks,
  getTaskByShortcode,
  liveSubtasks,
  TASK_DELETE_EDGE_POLICY,
  updateTask,
  updateTaskRead,
} from "./crud";
import { taskList, taskListRead } from "./lookup";

export const taskRepository = defineRepository("task", {
  lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
  get: onDb(getTaskByShortcode),
  list: (ctx, filters, sorts, pagination) =>
    taskList(ctx.db, filters, sorts, pagination, "page"),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    taskListRead(ctx.db, filters, sorts, pagination, projection, "page"),
  create: asActor(createTask),
  createRead: (ctx, data, fields) =>
    createTaskRead(ctx.db, data, ctx.actorContext, fields),
  update: (ctx, id, data) =>
    updateTask(ctx.db, id, data, ctx.actorContext, ctx.caldavHooks?.task),
  updateRead: (ctx, id, data, fields) =>
    updateTaskRead(
      ctx.db,
      id,
      data,
      ctx.actorContext,
      fields,
      ctx.caldavHooks?.task,
    ),
  // Subtasks go with their parent; report every removed task. Older data can
  // nest deeper than the one-level cascade: a surviving task below a removed
  // one inherited through it, so its projection is refreshed with its own
  // descendants'.
  delete: async (ctx, ids) => {
    const result = await deleteTasks(ctx.db, ids, ctx.actorContext);
    const survivors = (await liveSubtasks(getDb(ctx.db), result.ids)).map(
      (row) => row.id,
    );
    await refreshDerivedSearchRefs(
      ctx.db,
      survivors.map((entityId) => ({
        entityKind: "task" as const,
        entityId,
      })),
      "task.delete.inheritingDescendants",
    );
    return { ...result, removed: result.shortcodes };
  },
});
