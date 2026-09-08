import { taskSortableFields } from "@cubby/schemas/project";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

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
    update: (ctx, id, data) =>
      updateTask(ctx.db, id, data, ctx.actorContext, ctx.caldavHooks?.task),
    delete: async (ctx, ids) => {
      const { deletedShortcodes } = await deleteTasks(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      return {
        deletedReferences: entityMutationReferences("task", deletedShortcodes),
      };
    },
    /** One complete patch, one transaction, then one side-effect fan-out. */
    bulkUpdate: async (ctx, ids, data) => {
      const result = await updateTasksInBulk(
        ctx.db,
        ids,
        data,
        ctx.actorContext,
      );
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        result.updatedIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entityType: "task" as const, entityId },
          source: "task.bulkUpdate",
        })),
      );
      return {
        updatedReferences: entityMutationReferences(
          "task",
          result.updatedShortcodes,
        ),
        backgroundBatches,
      };
    },
  },
});
