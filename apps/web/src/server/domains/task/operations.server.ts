import type { ActorContext } from "@cubby/schemas/context";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import { taskBulkReorderInput } from "@cubby/schemas/project";
import type { z } from "zod";

import { taskContract } from "~/contracts/task.contract";
import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import { listActionableTasks } from "~/server/domains/task/repo/actionable";
import { reorderTasks } from "~/server/domains/task/repo/crud";
import { taskList } from "~/server/domains/task/repo/lookup";
import { getTaskSummary } from "~/server/domains/task/repo/summary";
import { getTaskTimeline } from "~/server/domains/task/repo/timeline";
import { recordChange } from "~/server/generic/changes/repo/change";
import { listAll } from "~/server/generic/list/repo/list-all";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

/**
 * `task.bulkReorder` stays bespoke — it is positional, not a field patch, so
 * it is in no `capabilities.bulkUpdate` field mask. It enrolls source intent
 * inside its own transaction, like the kernel's scalar bulk updates.
 */
type ReorderInput = z.output<typeof taskBulkReorderInput>;
type ReorderContext = { db: Database; actorContext: ActorContext };
const bulkReorderWorkflow = bindWorkflow(
  workflow<ReorderContext, ReorderInput>("task.bulkReorder")
    .commit("items", async ({ context }, { input }) =>
      withTransactionDatabase(context.db, async (transactionDb) => {
        const result = await reorderTasks(
          transactionDb,
          taskBulkReorderInput.parse(input),
          context.actorContext,
        );
        await recordChange(transactionDb, {
          kind: "source",
          categories: ["task"],
        });
        return result;
      }),
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
  timeline: (context, input) => getTaskTimeline(context.db, input),
  bulkReorder: (context, input) =>
    taskBulkReorderWorkflow(context.db, input, context.actorContext),
});
