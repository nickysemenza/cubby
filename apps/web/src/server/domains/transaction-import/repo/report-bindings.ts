import { importReconciliationSummary } from "~/server/domains/transaction-import/repo/report-summary";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "transactionImport.reconciliation-summary": reportBuilder(
    importReconciliationSummary,
  ),
};
