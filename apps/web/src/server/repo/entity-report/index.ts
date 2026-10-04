import type { ActorContext } from "@cubby/schemas/context";
import type {
  EntityReportInput,
  EntityReportOut,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";

import { expenseSettlementReport } from "./expense-settlement";
import { locationContentsValuationReport } from "./location";
import { mealCompositionReport } from "./meal";
import {
  projectAnalyticsReport,
  projectBudgetReport,
  projectContributionReport,
  projectScheduleReport,
} from "./project";
import { purchaseFinancialSettlementReport } from "./purchase-financial-settlement";
import { purchaseProjectAllocationReport } from "./purchase-project-allocation";
import { purchaseReconciliationReport } from "./purchase-reconciliation";
import {
  imageAssociationsReport,
  locationAiDescriptionReport,
  productCookbooksReport,
  productLabelsReport,
  productRecipeAppearancesReport,
  purchaseRunsReport,
  type ReportViewer,
} from "./records";
import { vendorAccountChargeSearchReport } from "./vendor-account-charge-search";

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
  "purchase.reconciliation": purchaseReconciliationReport,
  "purchase.project-allocation": purchaseProjectAllocationReport,
  "purchase.financial-settlement": purchaseFinancialSettlementReport,
  "expense.settlement": expenseSettlementReport,
  "vendorAccount.charge-search": (db, id, _viewer, actor) =>
    vendorAccountChargeSearchReport(db, id, actor),
} as const satisfies Record<
  EntityReportInput["slot"],
  (
    db: Database,
    code: string,
    viewer: ReportViewer,
    actor: ActorContext,
  ) => Promise<EntityReportOut["blocks"]>
>;

/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
  viewer: ReportViewer,
  actor: ActorContext,
): Promise<EntityReportOut> {
  return { blocks: await BUILDERS[input.slot](db, input.id, viewer, actor) };
}
