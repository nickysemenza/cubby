import type {
  EntityReportInput,
  EntityReportOut,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";

import { locationContentsValuationReport } from "./location";
import { mealCompositionReport } from "./meal";
import {
  projectAnalyticsReport,
  projectBudgetReport,
  projectContributionReport,
  projectScheduleReport,
} from "./project";
import {
  imageAssociationsReport,
  locationAiDescriptionReport,
  productCookbooksReport,
  productLabelsReport,
  productRecipeAppearancesReport,
  purchaseRunsReport,
  type ReportViewer,
} from "./records";

const BUILDERS = {
  "project.budget": projectBudgetReport,
  "project.contribution": projectContributionReport,
  "project.analytics": projectAnalyticsReport,
  "project.schedule": projectScheduleReport,
  "location.contents-valuation": locationContentsValuationReport,
  "meal.composition": mealCompositionReport,
  "product.labels": productLabelsReport,
  "product.cookbooks": productCookbooksReport,
  "product.recipe-appearances": productRecipeAppearancesReport,
  "image.associations": imageAssociationsReport,
  "purchase.runs": purchaseRunsReport,
  "location.ai-description": locationAiDescriptionReport,
} as const satisfies Record<
  EntityReportInput["slot"],
  (
    db: Database,
    code: string,
    viewer: ReportViewer,
  ) => Promise<EntityReportOut["blocks"]>
>;

/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
  viewer: ReportViewer,
): Promise<EntityReportOut> {
  return { blocks: await BUILDERS[input.slot](db, input.id, viewer) };
}
