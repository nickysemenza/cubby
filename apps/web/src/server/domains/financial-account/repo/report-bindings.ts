import { accountReviewSummary } from "~/server/domains/financial-account/repo/report-summary";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "financialAccount.review-summary": reportBuilder(accountReviewSummary),
};
