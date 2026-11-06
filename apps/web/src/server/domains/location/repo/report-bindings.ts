import { locationContentsValuationReport } from "~/server/domains/location/repo/report-location";
import { identityBuilder } from "~/server/generic/entity-report/repo/dependency";
import { locationId } from "~/server/generic/entity-report/repo/record-dependencies";
import { locationAiDescriptionReport } from "~/server/generic/entity-report/repo/records";

export const reportBindings = {
  "location.contents-valuation": identityBuilder(
    locationId,
    locationContentsValuationReport,
  ),
  "location.ai-description": identityBuilder(
    locationId,
    locationAiDescriptionReport,
  ),
};
