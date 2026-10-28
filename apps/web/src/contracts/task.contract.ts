import { taskFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/task";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const taskContract = defineContract(
  "task",
  {
    listActionable: query({
      exposure: "capability",
      description:
        "Unblocked tasks you can act on now — live, not done, and blocked by nothing — plus blocked tasks with transitive why-chains explaining what's in the way (a manual blocked flag, a blocking task, or a blocking project, nearest blocker first).",
      input: schemas.taskFiltersSchema.optional(),
      output: schemas.actionableTasksOut.extend({
        next: z.array(taskFieldEnvelopeSchemas.detail),
        later: z.array(taskFieldEnvelopeSchemas.detail),
        blocked: z.array(
          schemas.blockedTaskOut.extend({
            task: taskFieldEnvelopeSchemas.detail,
          }),
        ),
      }),
    }),
    chartData: query({
      input: schemas.taskFiltersSchema,
      output: z.array(taskFieldEnvelopeSchemas.detail),
    }),
    summary: query({
      exposure: "capability",
      description:
        "Task counts in one cheap call: totalOpen, next (unblocked and actionable now), later, inbox (no project), overdue, dueThisWeek (rolling 7 days), blocked. Size the backlog before paging entity_read.list(task).",
      input: z.undefined(),
      output: schemas.taskSummaryOut,
    }),
    timeline: query({
      input: schemas.taskFiltersSchema,
      output: schemas.taskTimelineOut.extend({
        tasks: z.array(taskFieldEnvelopeSchemas.detail),
      }),
    }),
    bulkReorder: mutation({
      note: "Board drag ordering",
      command: { label: "Reorder tasks", confirmation: null },
      input: schemas.taskBulkReorderInput,
      output: schemas.taskBulkMutationOut.extend({
        items: z.array(taskFieldEnvelopeSchemas.detail),
      }),
      invalidates: ["task"],
    }),
  },
  { exposure: "view", mcpToolGroup: "tasks_overview" },
);
