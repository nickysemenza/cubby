import { task } from "~/app/tasks/task.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  taskBoardWorkflow,
  taskBulkMoveWorkflow,
  taskBulkReorderWorkflow,
  taskBulkSetDueDateWorkflow,
  taskBulkSetStatusWorkflow,
  taskBulkSetTradeWorkflow,
  taskChartDataWorkflow,
  taskListActionableWorkflow,
  taskSummaryWorkflow,
  taskTimelineWorkflow,
  taskTodayBriefingWorkflow,
} from "~/server/workflows/task.server";

export const taskHandlers = implementOperationDomain(task, {
  listActionable: (context, input) =>
    taskListActionableWorkflow(context.db, input),
  chartData: (context, input) => taskChartDataWorkflow(context.db, input),
  summary: (context) => taskSummaryWorkflow(context.db),
  todayBriefing: (context) => taskTodayBriefingWorkflow(context.db),
  board: (context, input) => taskBoardWorkflow(context.db, input),
  timeline: (context, input) => taskTimelineWorkflow(context.db, input),
  bulkMove: (context, input) =>
    taskBulkMoveWorkflow(context.db, input, context.actorContext),
  bulkSetStatus: (context, input) =>
    taskBulkSetStatusWorkflow(context.db, input, context.actorContext),
  bulkSetTrade: (context, input) =>
    taskBulkSetTradeWorkflow(context.db, input, context.actorContext),
  bulkSetDueDate: (context, input) =>
    taskBulkSetDueDateWorkflow(context.db, input, context.actorContext),
  bulkReorder: (context, input) =>
    taskBulkReorderWorkflow(context.db, input, context.actorContext),
});
