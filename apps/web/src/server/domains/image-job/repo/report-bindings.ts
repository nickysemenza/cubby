import { imageJobAttemptsReport } from "~/server/domains/image-job/repo/report-image-job";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "imageJob.attempts": reportBuilder(imageJobAttemptsReport),
};
