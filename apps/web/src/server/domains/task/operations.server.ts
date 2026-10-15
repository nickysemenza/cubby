import type { ActorContext } from "@cubby/schemas/context";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import { taskBulkReorderInput } from "@cubby/schemas/project";
import type { z } from "zod";

import { taskContract } from "~/contracts/task.contract";
import type { Database } from "~/server/db";
import { listActionableTasks } from "~/server/domains/task/repo/actionable";
import { getTaskBoard } from "~/server/domains/task/repo/board";
import { reorderTasks } from "~/server/domains/task/repo/crud";
import { taskList } from "~/server/domains/task/repo/lookup";
import { getTaskSummary } from "~/server/domains/task/repo/summary";
import { getTaskTimeline } from "~/server/domains/task/repo/timeline";
import { getTaskTodayBriefing } from "~/server/domains/task/repo/today-briefing";
import { runMutationSideEffectsForEntities } from "~/server/entity-kernel/repo/mutation-side-effects";
import { listAll } from "~/server/generic/list/repo/list-all";
import { resolveAllPresent } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

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
  listActionable: (context, input) =>
    listActionableTasks(context.db, input ?? {}),
  chartData: async (context, input) =>
    (
      await listAll((pagination) =>
        taskList(
          context.db,
          input,
          [{ orderBy: "createdAt", direction: "desc" }],
          pagination,
          "page",
        ),
      )
    ).data,
  summary: (context) => getTaskSummary(context.db),
  todayBriefing: (context) => getTaskTodayBriefing(context.db),
  board: (context, input) => getTaskBoard(context.db, input),
  timeline: (context, input) => getTaskTimeline(context.db, input),
  bulkReorder: (context, input) =>
    taskBulkReorderWorkflow(context.db, input, context.actorContext),
});
