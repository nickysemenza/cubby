import { expenseContract } from "~/contracts/expense.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  expenseAnalyticsWorkflow,
  expenseAnalyzeWorkflow,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseFacetCountsWorkflow,
  expenseMonthlySummaryWorkflow,
  expenseInventoryOwnershipContextWorkflow,
  confirmInventoryExpenseBeneficiaryWorkflow,
  expenseTradeAffinityWorkflow,
} from "~/server/workflows/expense.server";

export const expenseHandlers = implementOperationDomain(expenseContract, {
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
  inventoryOwnershipContext: (context, input) =>
    expenseInventoryOwnershipContextWorkflow(context.db, input),
  confirmInventoryBeneficiary: (context, input) =>
    confirmInventoryExpenseBeneficiaryWorkflow(
      { db: context.db, actorContext: context.actorContext },
      input,
    ),
});
