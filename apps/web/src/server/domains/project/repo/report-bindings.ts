import type { EntityReportInput } from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
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
  collection: {
    "project.analytics": async (db: Database, input: EntityReportInput) =>
      (
        await import("~/server/domains/project/repo/report-portfolio")
      ).projectPortfolioReport(db, input),
  },
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
