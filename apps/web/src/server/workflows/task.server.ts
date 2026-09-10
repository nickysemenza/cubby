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
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export { taskFiltersSchema };

const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 } as const;

export const taskListActionableWorkflow = defineWorkflowOperation(
  "task.listActionable",
  (db: Database, input: z.output<typeof taskFiltersSchema> | undefined) =>
    listActionableTasks(db, input ?? {}),
);
type TaskFilters = z.output<typeof taskFiltersSchema>;
export const taskChartDataWorkflow = bindWorkflow(
  workflow<Database, TaskFilters>("task.chartData")
    .call("read", async ({ context }, { input }) =>
      taskList(
        context,
        input,
        [{ orderBy: "createdAt", direction: "desc" }],
        FETCH_ALL,
      ),
    )
    .output(({ read }) => read.data),
  (db: Database, input: TaskFilters) => ({ context: db, input }),
);
export const taskSummaryWorkflow = defineWorkflowOperation(
  "task.summary",
  (db: Database) => getTaskSummary(db),
);
export const taskTodayBriefingWorkflow = defineWorkflowOperation(
  "task.todayBriefing",
  getTaskTodayBriefing,
);
export const taskBoardWorkflow = defineWorkflowOperation(
  "task.board",
  getTaskBoard,
);
export const taskTimelineWorkflow = defineWorkflowOperation(
  "task.timeline",
  getTaskTimeline,
);

/**
 * `task.bulkReorder` stays bespoke — it is positional, not a field patch, so
 * it is in no `capabilities.bulkUpdate` field mask. The side-effect fan-out
 * every task bulk write used to share lives with the kernel's
 * `task.bulkUpdate` now; this is the one caller left needing it here.
 */
type ReorderInput = z.output<typeof taskBulkReorderInput>;
type ReorderContext = { db: Database; actorContext: ActorContext };
export const taskBulkReorderWorkflow = bindWorkflow(
  workflow<ReorderContext, ReorderInput>("task.bulkReorder")
    .commit("items", async ({ context }, { input }) =>
      reorderTasks(
        context.db,
        taskBulkReorderInput.parse(input),
        context.actorContext,
      ),
    )
    .effect("entityIds", async ({ context }, { items }) =>
      resolveAllPresent(
        context.db,
        "task",
        items.map((item) => item.id),
      ),
    )
    .effect("backgroundBatches", async ({ context }, { entityIds }) =>
      runMutationSideEffectsForEntities(
        context.db,
        entityIds.map((id) => ({
          action: "updated",
          entity: { entity: "task", id },
          source: "task.bulkReorder",
        })),
      ),
    )
    .output(({ items, backgroundBatches }) => ({
      items,
      sideEffects: { backgroundBatches },
    })),
  (db: Database, input: ReorderInput, actorContext: ActorContext) => ({
    context: { db, actorContext },
    input,
  }),
);
