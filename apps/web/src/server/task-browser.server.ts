import { task } from "~/app/tasks/task.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  taskBoardWorkflow,
  taskBulkReorderWorkflow,
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
  bulkReorder: (context, input) =>
    taskBulkReorderWorkflow(context.db, input, context.actorContext),
});
