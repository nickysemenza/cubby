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
    tags: [["task"], ["task", "listActionable"]],
  }),
  chartData: query({
    input: schemas.taskFiltersSchema,
    output: z.array(schemas.taskOut),
    tags: [["task"], ["task", "chartData"]],
  }),
  summary: query({
    input: z.undefined(),
    output: schemas.taskSummaryOut,
    tags: [["task"], ["task", "summary"]],
  }),
  todayBriefing: query({
    input: z.undefined(),
    output: schemas.taskTodayBriefingOut,
    tags: [["task"], ["task", "todayBriefing"]],
  }),
  board: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskBoardOut,
    tags: [["task"], ["task", "board"]],
  }),
  timeline: query({
    input: schemas.taskFiltersSchema,
    output: schemas.taskTimelineOut,
    tags: [["task"], ["task", "timeline"]],
  }),
  bulkMove: mutation({
    input: schemas.taskBulkMoveInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
  bulkSetStatus: mutation({
    input: schemas.taskBulkStatusInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
  bulkSetTrade: mutation({
    input: schemas.taskBulkTradeInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
  bulkSetDueDate: mutation({
    input: schemas.taskBulkDueDateInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
  bulkReorder: mutation({
    input: schemas.taskBulkReorderInput,
    output: schemas.taskBulkMutationOut,
    invalidates: ripple.task,
  }),
});
