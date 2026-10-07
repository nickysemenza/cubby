import type { ActorContext } from "@cubby/schemas/context";
import type {
  ReportBlock,
  EntityReportInput,
  EntityReportManyInput,
  EntityReportManyOut,
  EntityReportOut,
} from "@cubby/schemas/entity-report";
import { runShortcode } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type { RequestServices } from "~/server/request-services";

import {
  cookbookExtractionReport,
  cookbookImportProgressReport,
} from "./cookbook";
import { expenseSettlementReport } from "./expense-settlement";
import { locationContentsValuationReport } from "./location";
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
  ingredientRecipeUsagesReport,
  locationAiDescriptionReport,
  productCookbooksReport,
  productLabelsReport,
  productRecipeAppearancesReport,
  purchaseRunsReport,
  type ReportViewer,
} from "./records";
import type { RunReportSlot } from "./run";
import { vendorAccountChargeSearchReport } from "./vendor-account-charge-search";
import { vendorAccountSyncReport } from "./vendor-account-sync";

const isRunSlot = (slot: string): slot is RunReportSlot =>
  slot.startsWith("run.");

/** Run reports load the run service; keep it out of every other report's closure. */
const runBuilder =
  (slot: RunReportSlot) =>
  async (
    db: Database,
    code: string,
    _viewer: ReportViewer,
    _actor: ActorContext,
    cursor?: string,
  ): Promise<EntityReportOut> => {
    const { runReport } = await import("./run");
    return runReport(db, slot, runShortcode.parse(code), cursor);
  };

type ReportServices = RequestServices["services"];

/**
 * Recipe reports load the costing and availability engines; keep them off every other report's
 * closure, and off the Worker's first-request path.
 */
const recipeBuilder =
  (name: "recipeAvailabilityReport" | "recipeCostingCoverageReport") =>
  async (
    db: Database,
    code: string,
    _viewer: ReportViewer,
    _actor: ActorContext,
    _cursor?: string,
    services?: ReportServices,
  ): Promise<ReportBlock[]> => {
    if (!services) throw new Error("This report needs the request's services.");
    return (await import("./recipe"))[name](db, code, services);
  };

const BUILDERS = {
  "project.budget": projectBudgetReport,
  "project.contribution": projectContributionReport,
  "project.analytics": projectAnalyticsReport,
  "project.schedule": projectScheduleReport,
  "recipe.availability": recipeBuilder("recipeAvailabilityReport"),
  "recipe.costing-coverage": recipeBuilder("recipeCostingCoverageReport"),
  // The stored flow's AI service stays off every other report's closure.
  "recipe.walkthrough": async (db, id) =>
    (await import("./recipe-walkthrough")).recipeWalkthroughReport(db, id),
  "location.contents-valuation": locationContentsValuationReport,
  // Costs the batch for its portions, so the meal service stays off every other report's closure.
  "meal.composition": async (db, id, _viewer, _actor, _cursor, services) => {
    if (!services) throw new Error("This report needs the request's services.");
    return (await import("./meal")).mealCompositionReport(db, id, services);
  },
  "product.labels": productLabelsReport,
  "product.cookbooks": productCookbooksReport,
  "product.recipe-appearances": productRecipeAppearancesReport,
  "ingredient.recipe-usages": ingredientRecipeUsagesReport,
  "cookbook.extraction-report": cookbookExtractionReport,
  "cookbook.import-progress": cookbookImportProgressReport,
  "image.associations": imageAssociationsReport,
  "purchase.runs": purchaseRunsReport,
  "location.ai-description": locationAiDescriptionReport,
  "purchase.reconciliation": purchaseReconciliationReport,
  "purchase.project-allocation": purchaseProjectAllocationReport,
  "purchase.financial-settlement": purchaseFinancialSettlementReport,
  "expense.settlement": expenseSettlementReport,
  "vendorAccount.sync": (db, id, _viewer, actor) =>
    vendorAccountSyncReport(db, id, actor),
  "vendorAccount.charge-search": (db, id, _viewer, actor) =>
    vendorAccountChargeSearchReport(db, id, actor),
  "run.live-progress": runBuilder("run.live-progress"),
  "run.import-stats": runBuilder("run.import-stats"),
  "run.import-progress-live": runBuilder("run.import-progress-live"),
  "run.import-progress-stopped": runBuilder("run.import-progress-stopped"),
  "run.import-purchases": runBuilder("run.import-purchases"),
  "run.import-approvals": runBuilder("run.import-approvals"),
  "run.import-findings": runBuilder("run.import-findings"),
  "run.import-targets": runBuilder("run.import-targets"),
  "run.import-evidence": runBuilder("run.import-evidence"),
  "run.import-prepared-orders": runBuilder("run.import-prepared-orders"),
  "run.import-timeline": runBuilder("run.import-timeline"),
  "run.import-debug-log": runBuilder("run.import-debug-log"),
  "run.ai-usage": runBuilder("run.ai-usage"),
  "run.changes": runBuilder("run.changes"),
} as const satisfies Record<
  EntityReportInput["slot"],
  (
    db: Database,
    code: string,
    viewer: ReportViewer,
    actor: ActorContext,
    cursor?: string,
    services?: ReportServices,
  ) => Promise<EntityReportOut["blocks"] | EntityReportOut>
>;

/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportOut> {
  const report = await BUILDERS[input.slot](
    db,
    input.id,
    viewer,
    actor,
    input.cursor,
    services,
  );
  return Array.isArray(report) ? { blocks: report } : report;
}

/**
 * Several slots of one record. Run slots share one load of the run (`runReports`); other
 * records build their slots one by one. Slots must all belong to one entity.
 */
export async function buildEntityReports(
  db: Database,
  input: EntityReportManyInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportManyOut> {
  const runSlots = input.slots.filter(isRunSlot);
  if (runSlots.length === input.slots.length) {
    const { runReports } = await import("./run");
    return {
      reports: await runReports(
        db,
        runSlots,
        runShortcode.parse(input.id),
        undefined,
      ),
    };
  }
  if (runSlots.length > 0)
    throw new Error("A batched report must name slots of one entity.");
  const reports: EntityReportManyOut["reports"] = [];
  for (const slot of input.slots)
    reports.push({
      slot,
      report: await buildEntityReport(
        db,
        { slot, id: input.id },
        viewer,
        actor,
        services,
      ),
    });
  return { reports };
}
