import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";
import { imageAssociationsReport } from "~/server/generic/entity-report/repo/records";

export const reportBindings = {
  "image.associations": reportBuilder(imageAssociationsReport),
};
