/**
 * Task Router — steps inside household projects (migrated from Notion).
 * Pure crud-factory shape; the blocked-by graph is edited via `update`'s
 * `blockedByIds` replacement set.
 */

import { type TaskShortcode, taskShortcode } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  taskBoardOut,
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkReorderInput,
  taskBulkStatusInput,
  taskBulkTradeInput,
  taskCreateInput,
  taskFiltersSchema,
  taskListAndSideEffectsOut,
  taskOut,
  taskSortableFields,
  taskSummaryOut,
  taskTimelineOut,
  taskUpdateData,
} from "@cubby/schemas/project";
import { z } from "zod";
import {
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  createTask,
  deleteTasks,
  getTaskBoard,
  getTaskByID,
  getTaskByShortcode,
  getTaskSummary,
  getTaskTimeline,
  listActionableTasks,
  moveTasks,
  reorderTasks,
  setTasksDueDate,
  setTasksStatus,
  setTasksTrade,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  getByShortcode,
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
    sort: {
      sortableFields: taskSortableFields,
      defaultSort: "createdAt",
      groupableFields: ["status"] as const,
    },
    idSchema: taskShortcode,
  },
  repository: {
    getByID: async (services, shortcode: TaskShortcode) => {
      const id = await resolveOrThrow(services.db, "task", shortcode);
      return getTaskByID(services.db, id);
    },
    getByShortcode: (services, shortcode) =>
      getTaskByShortcode(services.db, shortcode),
    list: async (services, filters, sort, pagination) =>
      taskList(services.db, filters, sort, pagination),
    create: async (services, data) =>
      createTask(services.db, data, services.actorContext),
    update: async (services, shortcode: TaskShortcode, data) =>
      updateTask(services.db, shortcode, data, services.actorContext),
    delete: async (services, ids: TaskShortcode[]) => {
      await deleteTasks(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "task",
});

/**
 * Batch-resolve the shortcodes a bulk-write result carries into the internal
 * uuids `runMutationSideEffectsForEntities` keys on — one query for the
 * whole batch, not one per row.
 */
async function taskEntityIds(
  db: Parameters<typeof resolveAllPresent>[0],
  ids: TaskShortcode[],
) {
  return resolveAllPresent(db, "task", ids);
}

/**
 * The computed "what can I actually do" read behind the /tasks Next view:
 * every live, non-done task partitioned into unblocked-`next`,
 * unblocked-`later`, and `blocked` (with transitive why-chains). No input,
 * unpaginated — see repo/task/actionable.ts for the semantics/ordering.
 */
const listActionable = protectedProcedure
  .input(taskFiltersSchema.optional())
  .output(strictOutput(actionableTasksOut))
  .query(({ ctx, input }) => listActionableTasks(ctx.db, input ?? {}));

/**
 * Every task matching the filters, in one round trip — chart/Gantt aggregates
 * happen client-side, and `list`'s 500-row page cap would silently truncate a
 * big subtree (same fetch-all convention as expense.chartData).
 */
const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 };
const chartData = protectedProcedure
  .input(taskFiltersSchema)
  .output(strictOutput(z.array(taskOut)))
  .query(async ({ ctx, input }) => {
    const { data } = await taskList(
      ctx.db,
      input,
      [{ orderBy: "createdAt", direction: "desc" }],
      FETCH_ALL,
    );
    return data;
  });

// Bulk "move to project" — projectId: null moves every listed task to the
// inbox. Mirrors inventory.bulkMove's shape: one repo call inside a
// transaction, then one wave-wide runMutationSideEffectsForEntities so the
// embedding refresh for every moved task batches into a single dispatch.
const bulkMove = protectedProcedure
  .input(taskBulkMoveInput)
  .output(strictOutput(taskListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await moveTasks(ctx.db, input, ctx.actorContext);
    const ids = await taskEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "task.bulkMove",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk status write, same shape as bulkMove above.
const bulkSetStatus = protectedProcedure
  .input(taskBulkStatusInput)
  .output(strictOutput(taskListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await setTasksStatus(ctx.db, input, ctx.actorContext);
    const ids = await taskEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "task.bulkSetStatus",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk trade write, same shape as bulkSetStatus above.
const bulkSetTrade = protectedProcedure
  .input(taskBulkTradeInput)
  .output(strictOutput(taskListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await setTasksTrade(ctx.db, input, ctx.actorContext);
    const ids = await taskEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "task.bulkSetTrade",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk due-date write, same shape as bulkSetTrade above.
const bulkSetDueDate = protectedProcedure
  .input(taskBulkDueDateInput)
  .output(strictOutput(taskListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await setTasksDueDate(ctx.db, input, ctx.actorContext);
    const ids = await taskEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "task.bulkSetDueDate",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Board drag-to-prioritize "materialize" path (see board-model.ts
// computeRank). One repo call inside a transaction re-ranks a run of cards and
// optionally applies the dragged card's axis move. Side-effects (embedding
// refresh) run ONLY for the axis-moved card — a pure sortOrder write doesn't
// change embedding text — not for every re-ranked row.
const bulkReorder = protectedProcedure
  .input(taskBulkReorderInput)
  .output(strictOutput(taskListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await reorderTasks(ctx.db, input, ctx.actorContext);
    const movedIds = input.move ? [input.move.id] : [];
    const ids = await taskEntityIds(ctx.db, movedIds);
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "task.bulkReorder",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

/**
 * Cheap counts for the /tasks summary strip — `totalOpen`/`next`/`later`/
 * `inbox`/`overdue`/`dueThisWeek`/`blocked` — replacing a full-history fetch
 * done client-side. No input; see repo/task/summary.ts for the exact
 * SQL/reuse per count.
 */
const summary = protectedProcedure
  .output(strictOutput(taskSummaryOut))
  .query(({ ctx }) => getTaskSummary(ctx.db));

/**
 * The board's data source: every active (non-done) top-level task matching
 * the filters, plus the 20 most-recently-updated done tasks and the true
 * done count — replacing the old `chartData({topLevelOnly: true})`
 * fetch-everything-then-cap-client-side pattern. See repo/task/board.ts.
 */
const board = protectedProcedure
  .input(taskFiltersSchema)
  .output(strictOutput(taskBoardOut))
  .query(({ ctx, input }) => getTaskBoard(ctx.db, input));

const timeline = protectedProcedure
  .input(taskFiltersSchema)
  .output(strictOutput(taskTimelineOut))
  .query(({ ctx, input }) => getTaskTimeline(ctx.db, input));

export const taskRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
  listActionable,
  chartData,
  summary,
  board,
  timeline,
  bulkMove,
  bulkSetStatus,
  bulkSetTrade,
  bulkSetDueDate,
  bulkReorder,
});
