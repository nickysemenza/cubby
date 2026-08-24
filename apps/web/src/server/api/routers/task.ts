import {
  actionableTasksOut,
  taskBoardOut,
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkReorderInput,
  taskBulkStatusInput,
  taskBulkTradeInput,
  taskFiltersSchema,
  taskOut,
  taskSummaryOut,
  taskTimelineOut,
} from "@cubby/schemas/project";
import { z } from "zod";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import {
  getTaskBoard,
  getTaskSummary,
  getTaskTimeline,
  listActionableTasks,
  moveTasks,
  reorderTasks,
  setTasksDueDate,
  setTasksStatus,
  setTasksTrade,
  taskList,
} from "~/server/repo/task";
import { createBulkUpdatedMutation } from "../crud-factory";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createEntityCompatibilityProcedures(
  ENTITY_KERNEL_BINDINGS.task,
  ENTITY_BINDINGS.task.crud,
);

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
const bulkMove = createBulkUpdatedMutation({
  input: taskBulkMoveInput,
  itemOutput: taskOut,
  entity: "task",
  source: "task.bulkMove",
  mutate: (ctx, input) => moveTasks(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk status write, same shape as bulkMove above.
const bulkSetStatus = createBulkUpdatedMutation({
  input: taskBulkStatusInput,
  itemOutput: taskOut,
  entity: "task",
  source: "task.bulkSetStatus",
  mutate: (ctx, input) => setTasksStatus(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk trade write, same shape as bulkSetStatus above.
const bulkSetTrade = createBulkUpdatedMutation({
  input: taskBulkTradeInput,
  itemOutput: taskOut,
  entity: "task",
  source: "task.bulkSetTrade",
  mutate: (ctx, input) => setTasksTrade(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk due-date write, same shape as bulkSetTrade above.
const bulkSetDueDate = createBulkUpdatedMutation({
  input: taskBulkDueDateInput,
  itemOutput: taskOut,
  entity: "task",
  source: "task.bulkSetDueDate",
  mutate: (ctx, input) => setTasksDueDate(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Board drag-to-prioritize "materialize" path (see board-model.ts
// computeRank). One repo call inside a transaction re-ranks a run of cards and
// optionally applies the dragged card's axis move. Side-effects (embedding
// refresh) run ONLY for the axis-moved card — a pure sortOrder write doesn't
// change embedding text — not for every re-ranked row.
const bulkReorder = createBulkUpdatedMutation({
  input: taskBulkReorderInput,
  itemOutput: taskOut,
  entity: "task",
  source: "task.bulkReorder",
  mutate: (ctx, input) => reorderTasks(ctx.db, input, ctx.actorContext),
  entityShortcodes: (_items, input) => (input.move ? [input.move.id] : []),
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
