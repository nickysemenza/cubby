import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  actionableTasksOut,
  taskBoardOut,
  taskBoardWorkflow,
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkMoveWorkflow,
  taskBulkMutationOut,
  taskBulkReorderInput,
  taskBulkReorderWorkflow,
  taskBulkSetDueDateWorkflow,
  taskBulkSetStatusWorkflow,
  taskBulkSetTradeWorkflow,
  taskBulkStatusInput,
  taskBulkTradeInput,
  taskChartDataWorkflow,
  taskFiltersSchema,
  taskListActionableWorkflow,
  taskOut,
  taskSummaryOut,
  taskSummaryWorkflow,
  taskTimelineOut,
  taskTimelineWorkflow,
  taskTodayBriefingOut,
  taskTodayBriefingWorkflow,
} from "~/server/workflows/task.server";

export const listActionableTasksForBrowser = (o: {
  data: z.input<typeof taskFiltersSchema> | undefined;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.listActionable",
    type: "query",
    input: o.data,
    inputSchema: taskFiltersSchema.optional(),
    outputSchema: actionableTasksOut,
    request: o.request,
    run: (c, input) => taskListActionableWorkflow(c.db, input),
  });
export const getTaskChartDataForBrowser = (o: {
  data: z.input<typeof taskFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.chartData",
    type: "query",
    input: o.data,
    inputSchema: taskFiltersSchema,
    outputSchema: z.array(taskOut),
    request: o.request,
    run: (c, input) => taskChartDataWorkflow(c.db, input),
  });
export const getTaskSummaryForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.summary",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: taskSummaryOut,
    request: o.request,
    run: (c) => taskSummaryWorkflow(c.db),
  });
export const getTaskTodayBriefingForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.todayBriefing",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: taskTodayBriefingOut,
    request: o.request,
    run: (c) => taskTodayBriefingWorkflow(c.db),
  });
export const getTaskBoardForBrowser = (o: {
  data: z.input<typeof taskFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.board",
    type: "query",
    input: o.data,
    inputSchema: taskFiltersSchema,
    outputSchema: taskBoardOut,
    request: o.request,
    run: (c, input) => taskBoardWorkflow(c.db, input),
  });
export const getTaskTimelineForBrowser = (o: {
  data: z.input<typeof taskFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.timeline",
    type: "query",
    input: o.data,
    inputSchema: taskFiltersSchema,
    outputSchema: taskTimelineOut,
    request: o.request,
    run: (c, input) => taskTimelineWorkflow(c.db, input),
  });
export const bulkMoveTasksForBrowser = (o: {
  data: z.input<typeof taskBulkMoveInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.bulkMove",
    type: "mutation",
    input: o.data,
    inputSchema: taskBulkMoveInput,
    outputSchema: taskBulkMutationOut,
    request: o.request,
    run: (c, input) => taskBulkMoveWorkflow(c.db, input, c.actorContext),
  });
export const bulkSetTaskStatusForBrowser = (o: {
  data: z.input<typeof taskBulkStatusInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.bulkSetStatus",
    type: "mutation",
    input: o.data,
    inputSchema: taskBulkStatusInput,
    outputSchema: taskBulkMutationOut,
    request: o.request,
    run: (c, input) => taskBulkSetStatusWorkflow(c.db, input, c.actorContext),
  });
export const bulkSetTaskTradeForBrowser = (o: {
  data: z.input<typeof taskBulkTradeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.bulkSetTrade",
    type: "mutation",
    input: o.data,
    inputSchema: taskBulkTradeInput,
    outputSchema: taskBulkMutationOut,
    request: o.request,
    run: (c, input) => taskBulkSetTradeWorkflow(c.db, input, c.actorContext),
  });
export const bulkSetTaskDueDateForBrowser = (o: {
  data: z.input<typeof taskBulkDueDateInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.bulkSetDueDate",
    type: "mutation",
    input: o.data,
    inputSchema: taskBulkDueDateInput,
    outputSchema: taskBulkMutationOut,
    request: o.request,
    run: (c, input) => taskBulkSetDueDateWorkflow(c.db, input, c.actorContext),
  });
export const bulkReorderTasksForBrowser = (o: {
  data: z.input<typeof taskBulkReorderInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "task.bulkReorder",
    type: "mutation",
    input: o.data,
    inputSchema: taskBulkReorderInput,
    outputSchema: taskBulkMutationOut,
    request: o.request,
    run: (c, input) => taskBulkReorderWorkflow(c.db, input, c.actorContext),
  });
