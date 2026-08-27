import type { ActorContext } from "@cubby/schemas/context";
import {
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkReorderInput,
  taskBulkStatusInput,
  taskBulkTradeInput,
  taskFiltersSchema,
  taskOut,
} from "@cubby/schemas/project";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import {
  getTaskBoard,
  getTaskSummary,
  getTaskTimeline,
  getTaskTodayBriefing,
  listActionableTasks,
  moveTasks,
  reorderTasks,
  setTasksDueDate,
  setTasksStatus,
  setTasksTrade,
  taskList,
} from "~/server/repo/task";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

export {
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkReorderInput,
  taskBulkStatusInput,
  taskBulkTradeInput,
  taskFiltersSchema,
  taskOut,
};

const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 } as const;

export const taskListActionableWorkflow = (
  db: Database,
  input: z.output<typeof taskFiltersSchema> | undefined,
) => listActionableTasks(db, input ?? {});
export const taskChartDataWorkflow = async (
  db: Database,
  input: z.output<typeof taskFiltersSchema>,
) =>
  (
    await taskList(
      db,
      input,
      [{ orderBy: "createdAt", direction: "desc" }],
      FETCH_ALL,
    )
  ).data;
export const taskSummaryWorkflow = (db: Database) => getTaskSummary(db);
export const taskTodayBriefingWorkflow = (db: Database) =>
  getTaskTodayBriefing(db);
export const taskBoardWorkflow = (
  db: Database,
  input: z.output<typeof taskFiltersSchema>,
) => getTaskBoard(db, input);
export const taskTimelineWorkflow = (
  db: Database,
  input: z.output<typeof taskFiltersSchema>,
) => getTaskTimeline(db, input);

const bulkResult = async <T extends z.ZodTypeAny>(
  db: Database,
  actorContext: ActorContext,
  input: unknown,
  schema: T,
  source: string,
  mutate: (parsed: z.output<T>) => Promise<z.output<typeof taskOut>[]>,
) => {
  const items = await mutate(schema.parse(input));
  const ids = items.map((item) => item.id);
  const entityIds = await resolveAllPresent(db, "task", ids);
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    [...entityIds.values()].map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "task" as const, entityId },
      source,
    })),
  );
  void actorContext;
  return { items, sideEffects: { backgroundBatches } };
};

export const taskBulkMoveWorkflow = (
  db: Database,
  input: z.output<typeof taskBulkMoveInput>,
  actorContext: ActorContext,
) =>
  bulkResult(
    db,
    actorContext,
    input,
    taskBulkMoveInput,
    "task.bulkMove",
    (parsed) => moveTasks(db, parsed, actorContext),
  );
export const taskBulkSetStatusWorkflow = (
  db: Database,
  input: z.output<typeof taskBulkStatusInput>,
  actorContext: ActorContext,
) =>
  bulkResult(
    db,
    actorContext,
    input,
    taskBulkStatusInput,
    "task.bulkSetStatus",
    (parsed) => setTasksStatus(db, parsed, actorContext),
  );
export const taskBulkSetTradeWorkflow = (
  db: Database,
  input: z.output<typeof taskBulkTradeInput>,
  actorContext: ActorContext,
) =>
  bulkResult(
    db,
    actorContext,
    input,
    taskBulkTradeInput,
    "task.bulkSetTrade",
    (parsed) => setTasksTrade(db, parsed, actorContext),
  );
export const taskBulkSetDueDateWorkflow = (
  db: Database,
  input: z.output<typeof taskBulkDueDateInput>,
  actorContext: ActorContext,
) =>
  bulkResult(
    db,
    actorContext,
    input,
    taskBulkDueDateInput,
    "task.bulkSetDueDate",
    (parsed) => setTasksDueDate(db, parsed, actorContext),
  );
export const taskBulkReorderWorkflow = (
  db: Database,
  input: z.output<typeof taskBulkReorderInput>,
  actorContext: ActorContext,
) =>
  bulkResult(
    db,
    actorContext,
    input,
    taskBulkReorderInput,
    "task.bulkReorder",
    (parsed) => reorderTasks(db, parsed, actorContext),
  );
