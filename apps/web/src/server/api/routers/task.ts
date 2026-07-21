/**
 * Task Router — steps inside household projects (migrated from Notion).
 * Pure crud-factory shape; the blocked-by graph is edited via `update`'s
 * `blockedByIds` replacement set.
 */

import { type TaskId, taskId } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  taskCreateInput,
  taskFiltersSchema,
  taskOut,
  taskSortableFields,
  taskUpdateData,
} from "@cubby/schemas/project";
import { z } from "zod";
import {
  createTask,
  deleteTasks,
  getTaskByID,
  listActionableTasks,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createSearchableEntityCrudProcedures({
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
    create: async (services, data) =>
      createTask(services.db, data, services.actorContext),
    update: async (services, id: TaskId, data) =>
      updateTask(services.db, id, data, services.actorContext),
    delete: async (services, ids) => {
      await deleteTasks(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "task",
});

/**
 * The computed "what can I actually do" read behind the /tasks Actionable
 * view: every live, non-done task partitioned into unblocked vs blocked
 * (with transitive why-chains). No input, unpaginated — see
 * repo/task/actionable.ts for the semantics.
 */
const listActionable = protectedProcedure
  .output(actionableTasksOut)
  .query(({ ctx }) => listActionableTasks(ctx.db));

/**
 * Every task matching the filters, in one round trip — chart/Gantt aggregates
 * happen client-side, and `list`'s 500-row page cap would silently truncate a
 * big subtree (same fetch-all convention as purchase.chartData).
 */
const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 };
const chartData = protectedProcedure
  .input(taskFiltersSchema)
  .output(z.array(taskOut))
  .query(async ({ ctx, input }) => {
    const { data } = await taskList(
      ctx.db,
      input,
      [{ orderBy: "createdAt", direction: "desc" }],
      FETCH_ALL,
    );
    return data;
  });

export const taskRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  listActionable,
  chartData,
});
