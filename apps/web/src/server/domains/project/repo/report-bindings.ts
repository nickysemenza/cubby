import {
  projectAnalyticsReport,
  projectBudgetReport,
  projectContributionReport,
  projectScheduleReport,
} from "~/server/domains/project/repo/report-project";
import {
  projectContext,
  projectAnalytics,
  projectSpend,
} from "~/server/domains/project/repo/report-project-dependencies";
import { reportDependency } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "project.budget": reportDependency(async (execution) => ({
    blocks: await projectBudgetReport(
      await execution.read(projectContext),
      await execution.read(projectSpend),
    ),
  })),
  "project.contribution": reportDependency(async (execution) => ({
    blocks: await projectContributionReport(
      execution.request.db,
      await execution.read(projectContext),
    ),
  })),
  "project.analytics": reportDependency(async (execution) => ({
    blocks: await projectAnalyticsReport(
      await execution.read(projectAnalytics),
    ),
  })),
  "project.schedule": reportDependency(async (execution) => ({
    blocks: await projectScheduleReport(
      execution.request.db,
      await execution.read(projectContext),
    ),
  })),
};
