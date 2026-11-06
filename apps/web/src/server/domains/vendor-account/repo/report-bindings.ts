import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";
import { emailSummary } from "~/server/generic/entity-report/repo/summary";

export const reportBindings = {
  "vendorAccount.email-summary": reportBuilder((db, code) =>
    emailSummary(db, code, "vendorAccount"),
  ),
};
