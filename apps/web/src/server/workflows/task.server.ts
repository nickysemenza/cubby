import type { ActorContext } from "@cubby/schemas/context";
import {
  taskBulkReorderInput,
  taskFiltersSchema,
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
  reorderTasks,
  taskList,
} from "~/server/repo/task";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

export { taskBulkReorderInput, taskFiltersSchema };

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

/**
 * `task.bulkReorder` stays bespoke — it is positional, not a field patch, so
 * it is in no `capabilities.bulkUpdate` field mask. The side-effect fan-out
 * every task bulk write used to share lives with the kernel's
 * `task.bulkUpdate` now; this is the one caller left needing it here.
 */
export const taskBulkReorderWorkflow = async (
  db: Database,
  input: z.output<typeof taskBulkReorderInput>,
  actorContext: ActorContext,
) => {
  const items = await reorderTasks(
    db,
    taskBulkReorderInput.parse(input),
    actorContext,
  );
  const entityIds = await resolveAllPresent(
    db,
    "task",
    items.map((item) => item.id),
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    entityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "task" as const, entityId },
      source: "task.bulkReorder",
    })),
  );
  return { items, sideEffects: { backgroundBatches } };
};
