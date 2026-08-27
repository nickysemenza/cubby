import { expense } from "~/app/expenses/expense.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  expenseAnalyticsWorkflow,
  expenseAnalyzeWorkflow,
  expenseBulkMoveWorkflow,
  expenseBulkSetCostTypeWorkflow,
  expenseBulkSetTradeWorkflow,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseFacetCountsWorkflow,
  expenseMonthlySummaryWorkflow,
  expenseTradeAffinityWorkflow,
} from "~/server/workflows/expense.server";

export const expenseHandlers = implementOperationDomain(expense, {
  chartData: (context, input) => expenseChartDataWorkflow(context.db, input),
  analytics: (context, input) => expenseAnalyticsWorkflow(context.db, input),
  monthlySummary: (context, input) =>
    expenseMonthlySummaryWorkflow(context.db, input),
  analyze: (context, input) => expenseAnalyzeWorkflow(context.db, input),
  facetCounts: (context, input) =>
    expenseFacetCountsWorkflow(context.db, input),
  tradeAffinity: (context) => expenseTradeAffinityWorkflow(context.db),
  chargeContext: (context, input) =>
    expenseChargeContextWorkflow(context.db, input),
  bulkMove: (context, input) =>
    expenseBulkMoveWorkflow(context.db, input, context.actorContext),
  bulkSetTrade: (context, input) =>
    expenseBulkSetTradeWorkflow(context.db, input, context.actorContext),
  bulkSetCostType: (context, input) =>
    expenseBulkSetCostTypeWorkflow(context.db, input, context.actorContext),
});
