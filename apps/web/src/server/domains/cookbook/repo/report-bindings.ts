import {
  cookbookExtractionReport,
  cookbookImportProgressReport,
} from "~/server/domains/cookbook/repo/report-cookbook";
import { cookbookRecentRecipesSummary } from "~/server/domains/cookbook/repo/report-summary";
import { reportDependency } from "~/server/generic/entity-report/repo/dependency";
import {
  identityBuilder,
  reportBuilder,
} from "~/server/generic/entity-report/repo/dependency";
import { cookbookId } from "~/server/generic/entity-report/repo/record-dependencies";

export const reportBindings = {
  "cookbook.recent-recipes": reportBuilder(cookbookRecentRecipesSummary),
  "cookbook.extraction-report": identityBuilder(
    cookbookId,
    cookbookExtractionReport,
  ),
  "cookbook.import-progress": reportDependency(async (execution) => ({
    blocks: await cookbookImportProgressReport(
      execution.request.db,
      execution.request.id,
      await execution.read(cookbookId),
    ),
  })),
};
