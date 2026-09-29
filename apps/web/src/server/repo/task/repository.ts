import { bulkUpdatedWithSideEffects } from "~/server/entity-kernel/adapter";
import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";

import {
  createTask,
  deleteTasks,
  getTaskByShortcode,
  TASK_DELETE_EDGE_POLICY,
  updateTasksInBulk,
  updateTask,
} from "./crud";
import { taskList } from "./lookup";

export const taskRepository = defineRepository("task", {
  lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
  get: onDb(getTaskByShortcode),
  list: listOn(taskList),
  create: asActor(createTask),
  update: (ctx, id, data) =>
    updateTask(ctx.db, id, data, ctx.actorContext, ctx.caldavHooks?.task),
  // Subtasks go with their parent; report every removed task.
  delete: async (ctx, ids) => {
    const result = await deleteTasks(ctx.db, ids, ctx.actorContext);
    return { ...result, removed: result.shortcodes };
  },
  bulkUpdate: async (ctx, ids, data) =>
    bulkUpdatedWithSideEffects(
      ctx,
      "task",
      await updateTasksInBulk(ctx.db, ids, data, ctx.actorContext),
    ),
});
