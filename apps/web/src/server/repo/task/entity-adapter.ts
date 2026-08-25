import { taskFiltersSchema, taskSortableFields } from "@cubby/schemas/project";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import {
  createTask,
  deleteTasks,
  getTaskByShortcode,
  TASK_DELETE_EDGE_POLICY,
  updateTask,
} from "./crud";
import { taskList } from "./lookup";

export const taskEntityAdapter = defineEntityAdapter({
  entity: "task",
  filters: taskFiltersSchema,
  sort: {
    fields: taskSortableFields,
    default: "createdAt",
    groupable: ["status"],
  },
  lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getTaskByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      taskList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createTask(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateTask(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteTasks(ctx.db, ids, ctx.actorContext),
  },
});
