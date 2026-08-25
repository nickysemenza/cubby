import { expenseShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  expenseAnalyticsOut,
  expenseAnalyticsWorkflow,
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseAnalyzeWorkflow,
  expenseBulkCostTypeInput,
  expenseBulkMoveInput,
  expenseBulkMoveWorkflow,
  expenseBulkMutationOut,
  expenseBulkSetCostTypeWorkflow,
  expenseBulkSetTradeWorkflow,
  expenseBulkTradeInput,
  expenseChargeContextOut,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
  expenseFacetCountsWorkflow,
  expenseFiltersSchema,
  expenseMonthlySummaryOut,
  expenseMonthlySummaryWorkflow,
  expenseOut,
  expenseTradeAffinityOut,
  expenseTradeAffinityWorkflow,
} from "~/server/workflows/expense.server";

export const getExpenseChartDataForBrowser = (o: {
  data: z.input<typeof expenseFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.chartData",
    type: "query",
    input: o.data,
    inputSchema: expenseFiltersSchema,
    outputSchema: z.array(expenseOut),
    request: o.request,
    run: (c, input) => expenseChartDataWorkflow(c.db, input),
  });
export const getExpenseAnalyticsForBrowser = (o: {
  data: z.input<typeof expenseFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.analytics",
    type: "query",
    input: o.data,
    inputSchema: expenseFiltersSchema,
    outputSchema: expenseAnalyticsOut,
    request: o.request,
    run: (c, input) => expenseAnalyticsWorkflow(c.db, input),
  });
export const getExpenseMonthlySummaryForBrowser = (o: {
  data: z.input<typeof expenseFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.monthlySummary",
    type: "query",
    input: o.data,
    inputSchema: expenseFiltersSchema,
    outputSchema: expenseMonthlySummaryOut,
    request: o.request,
    run: (c, input) => expenseMonthlySummaryWorkflow(c.db, input),
  });
export const analyzeExpensesForBrowser = (o: {
  data: z.input<typeof expenseAnalyzeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.analyze",
    type: "query",
    input: o.data,
    inputSchema: expenseAnalyzeInput,
    outputSchema: expenseAnalyzeOut,
    request: o.request,
    run: (c, input) => expenseAnalyzeWorkflow(c.db, input),
  });
export const getExpenseFacetCountsForBrowser = (o: {
  data: z.input<typeof expenseFacetCountsInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.facetCounts",
    type: "query",
    input: o.data,
    inputSchema: expenseFacetCountsInput,
    outputSchema: expenseFacetCountsOut,
    request: o.request,
    run: (c, input) => expenseFacetCountsWorkflow(c.db, input),
  });
export const getExpenseTradeAffinityForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.tradeAffinity",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: z.array(expenseTradeAffinityOut),
    request: o.request,
    run: (c) => expenseTradeAffinityWorkflow(c.db),
  });
export const getExpenseChargeContextForBrowser = (o: {
  data: z.input<typeof expenseShortcode>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.chargeContext",
    type: "query",
    input: o.data,
    inputSchema: expenseShortcode,
    outputSchema: expenseChargeContextOut,
    request: o.request,
    run: (c, input) => expenseChargeContextWorkflow(c.db, input),
  });
export const bulkMoveExpensesForBrowser = (o: {
  data: z.input<typeof expenseBulkMoveInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.bulkMove",
    type: "mutation",
    input: o.data,
    inputSchema: expenseBulkMoveInput,
    outputSchema: expenseBulkMutationOut,
    request: o.request,
    run: (c, input) => expenseBulkMoveWorkflow(c.db, input, c.actorContext),
  });
export const bulkSetExpenseTradeForBrowser = (o: {
  data: z.input<typeof expenseBulkTradeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.bulkSetTrade",
    type: "mutation",
    input: o.data,
    inputSchema: expenseBulkTradeInput,
    outputSchema: expenseBulkMutationOut,
    request: o.request,
    run: (c, input) => expenseBulkSetTradeWorkflow(c.db, input, c.actorContext),
  });
export const bulkSetExpenseCostTypeForBrowser = (o: {
  data: z.input<typeof expenseBulkCostTypeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "expense.bulkSetCostType",
    type: "mutation",
    input: o.data,
    inputSchema: expenseBulkCostTypeInput,
    outputSchema: expenseBulkMutationOut,
    request: o.request,
    run: (c, input) =>
      expenseBulkSetCostTypeWorkflow(c.db, input, c.actorContext),
  });
