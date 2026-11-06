import { vendorFrequentProductsSummary } from "~/server/domains/vendor/repo/report-summary";
import { vendorMailSearchReport } from "~/server/domains/vendor/repo/report-vendor";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";
import { emailSummary } from "~/server/generic/entity-report/repo/summary";

export const reportBindings = {
  "vendor.frequent-products": reportBuilder(vendorFrequentProductsSummary),
  "vendor.email-summary": reportBuilder((db, code) =>
    emailSummary(db, code, "vendor"),
  ),
  "vendor.mail-search": reportBuilder(vendorMailSearchReport),
};
