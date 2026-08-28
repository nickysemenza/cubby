import type { TaskShortcode } from "@cubby/schemas/identifiers";
import { taskSortableFields } from "@cubby/schemas/project";

import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

import {
  createTask,
  deleteTasks,
  getTaskByShortcode,
  moveTasks,
  setTasksDueDate,
  setTasksStatus,
  setTasksTrade,
  TASK_DELETE_EDGE_POLICY,
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
    update: (ctx, id, data) => updateTask(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteTasks(ctx.db, ids, ctx.actorContext),
    /**
     * The kernel's `bulkUpdate` branch runs no side effects (it is shaped like
     * `delete`, not `update`), so the per-row fan-out that used to live in
     * `task.server.ts`'s `bulkResult` wrapper is dispatched here.
     *
     * The declared mask allows any subset of its fields, so each field group
     * runs its own audited write and `updated` is the union of the rows they
     * touched. `dueDate`/`dueEndDate` are one group: `setTasksDueDate` writes
     * the pair, so accepting half of it would silently null the other half.
     */
    bulkUpdate: async (ctx, ids, data) => {
      const touched = new Set<TaskShortcode>();
      const collect = async (rows: Promise<{ id: TaskShortcode }[]>) => {
        for (const row of await rows) touched.add(row.id);
      };
      if (data.projectId !== undefined) {
        await collect(
          moveTasks(
            ctx.db,
            { ids, projectId: data.projectId },
            ctx.actorContext,
          ),
        );
      }
      if (data.status !== undefined) {
        await collect(
          setTasksStatus(
            ctx.db,
            { ids, status: data.status },
            ctx.actorContext,
          ),
        );
      }
      if (data.trade !== undefined) {
        await collect(
          setTasksTrade(ctx.db, { ids, trade: data.trade }, ctx.actorContext),
        );
      }
      if (data.dueDate !== undefined || data.dueEndDate !== undefined) {
        if (data.dueDate === undefined || data.dueEndDate === undefined) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "A bulk due-date patch must supply both dueDate and dueEndDate.",
          );
        }
        await collect(
          setTasksDueDate(
            ctx.db,
            { ids, dueDate: data.dueDate, dueEndDate: data.dueEndDate },
            ctx.actorContext,
          ),
        );
      }
      const shortcodes = [...touched];
      const entityIds = await resolveAllPresent(ctx.db, "task", shortcodes);
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        entityIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entityType: "task" as const, entityId },
          source: "task.bulkUpdate",
        })),
      );
      return { updated: shortcodes.length, backgroundBatches };
    },
  },
});
