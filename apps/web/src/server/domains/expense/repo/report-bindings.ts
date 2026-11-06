import { expenseSettlementReport } from "~/server/domains/expense/repo/report-expense-settlement";
import { expenseAttributionSummary } from "~/server/domains/expense/repo/report-summary";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "expense.attribution-summary": reportBuilder(expenseAttributionSummary),
  "expense.settlement": reportBuilder(expenseSettlementReport),
};
