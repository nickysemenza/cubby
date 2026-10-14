import type { ActorContext } from "@cubby/schemas/context";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import {
  taskBulkReorderInput,
  taskFiltersSchema,
} from "@cubby/schemas/project";
import type { z } from "zod";

import { taskContract } from "~/contracts/task.contract";
import type { Database } from "~/server/db";
import { resolveCurrentMemberFilters } from "~/server/entity-kernel/current-member-filter";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listAll } from "~/server/repo/list-all";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { listActionableTasks } from "~/server/repo/task/actionable";
import { getTaskBoard } from "~/server/repo/task/board";
import { reorderTasks } from "~/server/repo/task/crud";
import { taskList } from "~/server/repo/task/lookup";
import { getTaskSummary } from "~/server/repo/task/summary";
import { getTaskTimeline } from "~/server/repo/task/timeline";
import { getTaskTodayBriefing } from "~/server/repo/task/today-briefing";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

/**
 * `task.bulkReorder` stays bespoke — it is positional, not a field patch, so
 * it is in no `capabilities.bulkUpdate` field mask. The side-effect fan-out
 * every task bulk write used to share lives with the kernel's
 * `task.bulkUpdate` now; this is the one caller left needing it here.
 */
type ReorderInput = z.output<typeof taskBulkReorderInput>;
type ReorderContext = { db: Database; actorContext: ActorContext };
const bulkReorderWorkflow = bindWorkflow(
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
    .effect("sideEffectsRun", async ({ context }, { entityIds }) =>
      runMutationSideEffectsForEntities(
        context.db,
        entityIds.map((id) => ({
          action: "updated",
          entity: { entity: "task", id },
          source: "task.bulkReorder",
        })),
      ),
    )
    .output(({ items }) => ({
      items,
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    })),
);

export const taskBulkReorderWorkflow = Object.assign(
  (db: Database, input: ReorderInput, actorContext: ActorContext) =>
    bulkReorderWorkflow({ db, actorContext }, input),
  { definition: bulkReorderWorkflow.definition },
);

export const taskHandlers = implementOperationDomain(taskContract, {
  listActionable: async (context, input) =>
    listActionableTasks(
      context.db,
      await resolveCurrentMemberFilters(
        context,
        taskFiltersSchema,
        input ?? {},
      ),
    ),
  chartData: async (context, input) => {
    const filters = await resolveCurrentMemberFilters(
      context,
      taskFiltersSchema,
      input,
    );
    return (
      await listAll((pagination) =>
        taskList(
          context.db,
          filters,
          [{ orderBy: "createdAt", direction: "desc" }],
          pagination,
          "page",
        ),
      )
    ).data;
  },
  summary: (context) => getTaskSummary(context.db),
  todayBriefing: (context) => getTaskTodayBriefing(context.db),
  // Board and timeline read outside the entity kernel, so they resolve `@me`
  // themselves.
  board: async (context, input) =>
    getTaskBoard(
      context.db,
      await resolveCurrentMemberFilters(context, taskFiltersSchema, input),
    ),
  timeline: async (context, input) =>
    getTaskTimeline(
      context.db,
      await resolveCurrentMemberFilters(context, taskFiltersSchema, input),
    ),
  bulkReorder: (context, input) =>
    taskBulkReorderWorkflow(context.db, input, context.actorContext),
});
