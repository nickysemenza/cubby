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

const BUILDERS = {
  "project.budget": projectBudgetReport,
  "project.contribution": projectContributionReport,
  "project.analytics": projectAnalyticsReport,
  "project.schedule": projectScheduleReport,
  "location.contents-valuation": locationContentsValuationReport,
  "meal.composition": mealCompositionReport,
} as const satisfies Record<
  EntityReportInput["slot"],
  (db: Database, code: string) => Promise<EntityReportOut["blocks"]>
>;

/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
): Promise<EntityReportOut> {
  return { blocks: await BUILDERS[input.slot](db, input.id) };
}
