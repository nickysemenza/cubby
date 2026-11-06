import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";
import { transactionSourcesSummary } from "~/server/generic/entity-report/repo/summary";

export const reportBindings = {
  "financialTransaction.source-summary": reportBuilder(
    transactionSourcesSummary,
  ),
};
