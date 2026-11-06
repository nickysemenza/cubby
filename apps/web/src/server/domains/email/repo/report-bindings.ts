import { emailReviewReport } from "~/server/domains/email/repo/report-email";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "email.review": reportBuilder(emailReviewReport),
};
