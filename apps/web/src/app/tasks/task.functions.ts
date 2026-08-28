import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const task = defineOperationDomain("task", {
  listActionable: query({
    input: schemas.taskFiltersSchema.optional(),
    output: schemas.actionableTasksOut,
    tags: [["task", "listActionable"]],
  }),
  chartData: query({
    input: schemas.taskFiltersSchema,
    output: z.array(schemas.taskOut),
    tags: [["task", "chartData"]],
  }),
  summary: query({
    input: z.undefined(),
    output: schemas.taskSummaryOut,
    tags: [["task", "summary"]],
  }),
  todayBriefing: query({
    input: z.undefined(),
    output: schemas.taskTodayBriefingOut,
    tags: [["task", "todayBriefing"]],
  }),
  board: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskBoardOut,
    tags: [["task", "board"]],
  }),
  timeline: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskTimelineOut,
    tags: [["task", "timeline"]],
  }),
  bulkReorder: mutation({
    input: schemas.taskBulkReorderInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
});
