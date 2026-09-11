import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const taskContract = defineContract("task", {
  listActionable: query({
    input: schemas.taskFiltersSchema.optional(),
    output: schemas.actionableTasksOut,
  }),
  chartData: query({
    input: schemas.taskFiltersSchema,
    output: z.array(schemas.taskOut),
  }),
  summary: query({
    input: z.undefined(),
    output: schemas.taskSummaryOut,
  }),
  todayBriefing: query({
    input: z.undefined(),
    output: schemas.taskTodayBriefingOut,
  }),
  board: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskBoardOut,
  }),
  timeline: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskTimelineOut,
  }),
  bulkReorder: mutation({
    input: schemas.taskBulkReorderInput,
    output: schemas.taskBulkMutationOut,
  }),
});
