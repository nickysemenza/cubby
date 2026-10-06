import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const taskContract = defineContract("task", {
  listActionable: query({
    input: schemas.taskFiltersSchema.optional(),
    output: schemas.actionableTasksOut,
  }),
  chartData: query({
    mcp: { omit: "client_view" },
    input: schemas.taskFiltersSchema,
    output: z.array(schemas.taskOut),
  }),
  summary: query({
    input: z.undefined(),
    output: schemas.taskSummaryOut,
  }),
  // Bounded Home summary; see expense.monthlySummary.
  todayBriefing: query({
    mcp: { omit: "agent_twin", twin: "task.listActionable" },
    readPolicy: "strong",
    native: "Today tasks",
    input: z.undefined(),
    output: schemas.taskTodayBriefingOut,
  }),
  board: query({
    mcp: { omit: "client_view" },
    native: "Task board",
    input: schemas.taskFiltersSchema,
    output: schemas.taskBoardOut,
  }),
  timeline: query({
    mcp: { omit: "client_view" },
    input: schemas.taskFiltersSchema,
    output: schemas.taskTimelineOut,
  }),
  bulkReorder: mutation({
    mcp: { omit: "client_view", note: "Board drag ordering" },
    native: "Task board ordering",
    input: schemas.taskBulkReorderInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ["task"],
  }),
});
