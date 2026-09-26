import {
  bulkUpdatedWithSideEffects,
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";

import {
  createTask,
  deleteTasks,
  getTaskByShortcode,
  TASK_DELETE_EDGE_POLICY,
  updateTasksInBulk,
  updateTask,
} from "./crud";
import { taskList } from "./lookup";

export const taskEntityAdapter = defineEntityAdapter({
  entity: "task",
  lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getTaskByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      taskList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createTask(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateTask(ctx.db, id, data, ctx.actorContext, ctx.caldavHooks?.task),
    delete: async (ctx, ids) => {
      const {
        shortcodes: deletedShortcodes,
        detachedImageKeys,
        deletedImageShortcodes,
      } = await deleteTasks(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: deletedWithImages(
          "task",
          deletedShortcodes,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
    bulkUpdate: async (ctx, ids, data) =>
      bulkUpdatedWithSideEffects(
        ctx,
        "task",
        await updateTasksInBulk(ctx.db, ids, data, ctx.actorContext),
      ),
  },
});
