/**
 * Task Router — steps inside household projects (migrated from Notion).
 * Pure crud-factory shape; the blocked-by graph is edited via `update`'s
 * `blockedByIds` replacement set.
 */

import { type TaskId, taskId } from "@cubby/schemas/identifiers";
import {
  taskCreateInput,
  taskFiltersSchema,
  taskOut,
  taskSortableFields,
  taskUpdateData,
} from "@cubby/schemas/project";
import {
  createTask,
  deleteTasks,
  getTaskByID,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter } from "../trpc";

const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: taskCreateInput,
    updateInput: taskUpdateData,
    output: taskOut,
    filters: taskFiltersSchema,
    sort: { sortableFields: taskSortableFields, defaultSort: "createdAt" },
    idSchema: taskId,
  },
  repository: {
    getByID: async (services, id: TaskId) => getTaskByID(services.db, id),
    list: async (services, filters, sort, pagination) =>
      taskList(services.db, filters, sort, pagination),
    create: async (services, data) => {
      const created = await createTask(
        services.db,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "created",
        entity: { entityType: "task", entityId: created.id },
        source: "task.create",
      });
      return created;
    },
    update: async (services, id: TaskId, data) => {
      const updated = await updateTask(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "updated",
        entity: { entityType: "task", entityId: id },
        source: "task.update",
      });
      return updated;
    },
  },
  entityName: "task",
});

const deleteItem = createDeleteProcedure<TaskId>(async (services, ids) => {
  await deleteTasks(services.db, ids, services.actorContext);
  return undefined;
}, taskId);

export const taskRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
});
