import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { recordChange } from "~/server/generic/changes/repo/change";

import {
  createTask,
  createTaskRead,
  deleteTasks,
  TASK_DELETE_EDGE_POLICY,
  updateTask,
  updateTaskRead,
} from "./crud";
import { taskScaffold } from "./lookup";

export const taskRepository = defineRepository("task", {
  lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
  scaffold: taskScaffold,
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
  delete: async (ctx, ids) => {
    const result = await deleteTasks(ctx.db, ids, ctx.actorContext);
    await recordChange(ctx.db, { kind: "source", categories: ["task"] });
    return { ...result, removed: result.shortcodes };
  },
});
