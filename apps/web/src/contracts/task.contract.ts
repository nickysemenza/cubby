import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
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
        next: z.array(entityFieldEnvelopeSchemas.task.detail),
        later: z.array(entityFieldEnvelopeSchemas.task.detail),
        blocked: z.array(
          schemas.blockedTaskOut.extend({
            task: entityFieldEnvelopeSchemas.task.detail,
          }),
        ),
      }),
    }),
    chartData: query({
      input: schemas.taskFiltersSchema,
      output: z.array(entityFieldEnvelopeSchemas.task.detail),
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
        tasks: z.array(entityFieldEnvelopeSchemas.task.detail),
      }),
    }),
    bulkReorder: mutation({
      note: "Board drag ordering",
      command: { label: "Reorder tasks", confirmation: null },
      input: schemas.taskBulkReorderInput,
      output: schemas.taskBulkMutationOut.extend({
        items: z.array(entityFieldEnvelopeSchemas.task.detail),
      }),
      invalidates: ["task"],
    }),
  },
  { exposure: "view", mcpToolGroup: "tasks_overview" },
);
