import type { ActorContext } from "@cubby/schemas/context";
import type {
  ReportBlock,
  EntityReportInput,
  EntityReportManyInput,
  EntityReportManyOut,
  EntityReportOut,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
import { foldRepeatedRows } from "~/server/generic/entity-report/repo/fold-repeats";
import { purchaseReconciliationReport } from "~/server/generic/entity-report/repo/purchase-reconciliation";
import type { RequestServices } from "~/server/http/request-services";

import {
  cookbookExtractionReport,
  cookbookImportProgressReport,
} from "./cookbook";
import {
  ReportExecution,
  reportDependency,
  type ReportDependency,
} from "./dependency";
import { emailReviewReport } from "./email";
import { expenseSettlementReport } from "./expense-settlement";
import { imageJobAttemptsReport } from "./image-job";
import { locationContentsValuationReport } from "./location";
import {
  projectAnalyticsReport,
  projectBudgetReport,
  projectContributionReport,
  projectScheduleReport,
} from "./project";
import {
  projectContext,
  projectAnalytics,
  projectSpend,
} from "./project-dependencies";
import { purchaseFinancialSettlementReport } from "./purchase-financial-settlement";
import { purchaseProjectAllocationReport } from "./purchase-project-allocation";
import {
  cookbookId,
  productId,
  recipeId,
  locationId,
  purchaseId,
  purchaseFinance,
  reportMember,
} from "./record-dependencies";
import {
  imageAssociationsReport,
  ingredientRecipeUsagesReport,
  locationAiDescriptionReport,
  productCookbooksReport,
  productLabelsReport,
  productRecipeAppearancesReport,
  recordRunsReport,
  type ReportViewer,
} from "./records";
import type { RunReportSlot } from "./run";
import { shipmentTrackingReport } from "./shipment";
import {
  productPricingSummary,
  productSellersReport,
  productStockSummary,
  productContextSummary,
  emailSummary,
  transactionSourcesSummary,
} from "./summary";
import {
  ingredientSellersSummary,
  vendorFrequentProductsSummary,
  cookbookRecentRecipesSummary,
  partyContributionSummary,
  importReconciliationSummary,
  partyHoldingsSummary,
  expenseAttributionSummary,
  accountReviewSummary,
} from "./summary-extensions";
import { vendorMailSearchReport } from "./vendor";

/** Run service imports remain outside every other report's closure. */
const runBuilder = (slot: RunReportSlot) =>
  reportDependency(async (execution): Promise<EntityReportOut> => {
    const { RUN_REPORTS } = await import("./run-dependencies");
    return execution.read(RUN_REPORTS[slot]);
  });

type ReportServices = RequestServices["services"];

/**
 * Recipe reports load the costing and availability engines; keep them off every other report's
 * closure, and off the Worker's first-request path.
 */
const recipeBuilder = (
  name: "recipeAvailabilityReport" | "recipeCostingCoverageReport",
) =>
  reportDependency(async (execution): Promise<EntityReportOut> => {
    const { id: code, services } = execution.request;
    if (!services) throw new Error("This report needs the request's services.");
    return {
      blocks: await (
        await import("./recipe")
      )[name](code, await execution.read(recipeId), services),
    };
  });

const identityBuilder = <T>(
  identity: ReportDependency<T>,
  build: (db: Database, id: T) => Promise<ReportBlock[]>,
) =>
  reportDependency(async (execution): Promise<EntityReportOut> => ({
    blocks: await build(execution.request.db, await execution.read(identity)),
  }));

type ReportBuilder = (
  db: Database,
  code: string,
  viewer: ReportViewer,
  actor: ActorContext,
  cursor?: string,
  services?: ReportServices,
) => Promise<EntityReportOut["blocks"] | EntityReportOut>;

const reportBuilder = (build: ReportBuilder) =>
  reportDependency(async ({ request }): Promise<EntityReportOut> => {
    const report = await build(
      request.db,
      request.id,
      request.viewer,
      request.actor,
      request.cursor,
      request.services,
    );
    return Array.isArray(report) ? { blocks: report } : report;
  });

const REPORTS = {
  "ingredient.sellers": reportBuilder(ingredientSellersSummary),
  "vendor.frequent-products": reportBuilder(vendorFrequentProductsSummary),
  "cookbook.recent-recipes": reportBuilder(cookbookRecentRecipesSummary),
  "ledgerParty.contribution-summary": reportBuilder(partyContributionSummary),
  "transactionImport.reconciliation-summary": reportBuilder(
    importReconciliationSummary,
  ),
  "ledgerParty.owned-holdings": reportBuilder(partyHoldingsSummary),
  "expense.attribution-summary": reportBuilder(expenseAttributionSummary),
  "financialAccount.review-summary": reportBuilder(accountReviewSummary),
  "product.sellers": reportDependency(async (execution) => ({
    blocks: await productSellersReport(
      execution.request.db,
      await execution.read(productId),
      execution.request.id,
    ),
  })),
  "product.pricing-summary": reportDependency(async (execution) => ({
    blocks: await productPricingSummary(
      execution.request.db,
      execution.request.id,
      await execution.read(productId),
    ),
  })),
  "product.stock-summary": reportDependency(async (execution) => ({
    blocks: await productStockSummary(
      execution.request.db,
      execution.request.id,
      await execution.read(productId),
    ),
  })),
  "product.use-summary": reportDependency(async (execution) => ({
    blocks: await productContextSummary(
      execution.request.db,
      execution.request.id,
      "uses",
      await execution.read(productId),
    ),
  })),
  "product.evidence-summary": reportDependency(async (execution) => ({
    blocks: await productContextSummary(
      execution.request.db,
      execution.request.id,
      "evidence",
      await execution.read(productId),
    ),
  })),
  "vendor.email-summary": reportBuilder((db, code) =>
    emailSummary(db, code, "vendor"),
  ),
  "vendorAccount.email-summary": reportBuilder((db, code) =>
    emailSummary(db, code, "vendorAccount"),
  ),
  "financialTransaction.source-summary": reportBuilder(
    transactionSourcesSummary,
  ),
  "shipment.tracking": reportBuilder(shipmentTrackingReport),
  "email.review": reportBuilder(emailReviewReport),
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
  "recipe.availability": recipeBuilder("recipeAvailabilityReport"),
  "recipe.costing-coverage": recipeBuilder("recipeCostingCoverageReport"),
  // The stored flow's AI service stays off every other report's closure.
  "recipe.walkthrough": reportDependency(async (execution) => ({
    blocks: await (
      await import("./recipe-walkthrough")
    ).recipeWalkthroughReport(
      execution.request.db,
      execution.request.id,
      await execution.read(recipeId),
    ),
  })),
  "location.contents-valuation": identityBuilder(
    locationId,
    locationContentsValuationReport,
  ),
  "vendor.mail-search": reportBuilder(vendorMailSearchReport),
  "meal.composition": reportBuilder(async (db, id) =>
    (await import("./meal")).mealCompositionReport(db, id),
  ),
  "product.labels": identityBuilder(productId, productLabelsReport),
  "product.cookbooks": identityBuilder(productId, productCookbooksReport),
  "product.recipe-appearances": identityBuilder(
    productId,
    productRecipeAppearancesReport,
  ),
  "ingredient.recipe-usages": reportBuilder(ingredientRecipeUsagesReport),
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
  "image.associations": reportBuilder(imageAssociationsReport),
  "imageJob.attempts": reportBuilder(imageJobAttemptsReport),
  "purchase.runs": reportDependency(async (execution) => {
    const party = await execution.read(reportMember);
    return {
      blocks: await recordRunsReport("purchase")(
        execution.request.db,
        await execution.read(purchaseId),
        party,
      ),
    };
  }),
  "product.runs": reportDependency(async (execution) => {
    const party = await execution.read(reportMember);
    return {
      blocks: await recordRunsReport("product")(
        execution.request.db,
        await execution.read(productId),
        party,
      ),
    };
  }),
  "location.ai-description": identityBuilder(
    locationId,
    locationAiDescriptionReport,
  ),
  "purchase.reconciliation": reportDependency(async (execution) => ({
    blocks: purchaseReconciliationReport(
      (await execution.read(purchaseFinance)).reconciliation!,
    ),
  })),
  "purchase.project-allocation": reportDependency(async (execution) => ({
    blocks: await purchaseProjectAllocationReport(
      execution.request.db,
      (await execution.read(purchaseFinance)).allocation!,
    ),
  })),
  "purchase.financial-settlement": reportDependency(async (execution) => ({
    blocks: await purchaseFinancialSettlementReport(
      execution.request.db,
      (await execution.read(purchaseFinance)).settlement!,
    ),
  })),
  "expense.settlement": reportBuilder(expenseSettlementReport),
  "run.live-progress": runBuilder("run.live-progress"),
  "run.import-stats": runBuilder("run.import-stats"),
  "run.import-progress-live": runBuilder("run.import-progress-live"),
  "run.import-progress-stopped": runBuilder("run.import-progress-stopped"),
  "run.import-purchases": runBuilder("run.import-purchases"),
  "run.import-findings": runBuilder("run.import-findings"),
  "run.import-targets": runBuilder("run.import-targets"),
  "run.import-prepared-orders": runBuilder("run.import-prepared-orders"),
  "run.import-timeline": runBuilder("run.import-timeline"),
  "run.import-debug-log": runBuilder("run.import-debug-log"),
  "run.steps": runBuilder("run.steps"),
  "run.results": runBuilder("run.results"),
  "run.ai-usage": runBuilder("run.ai-usage"),
  "run.suggestions": runBuilder("run.suggestions"),
  "run.decisions": runBuilder("run.decisions"),
  "run.diagnostics": runBuilder("run.diagnostics"),
  "run.changes": runBuilder("run.changes"),
} satisfies Record<
  Exclude<EntityReportInput["slot"], "task.briefing">,
  ReportDependency<EntityReportOut>
>;

/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportOut> {
  if (input.scope.kind !== "record") {
    const { buildCollectionReport } = await import("./collection");
    return foldRepeatedRows(await buildCollectionReport(db, input));
  }
  if (input.slot === "task.briefing")
    throw new Error("task.briefing does not support a record scope.");
  const execution = new ReportExecution({
    db,
    id: input.scope.id,
    slots: [input.slot],
    cursor: input.cursor,
    viewer,
    actor,
    services,
  });
  return foldRepeatedRows(await execution.read(REPORTS[input.slot]));
}

/** Slots preserve requested order and duplicates while sharing declared dependencies. */
export async function buildEntityReports(
  db: Database,
  input: EntityReportManyInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportManyOut> {
  const entity = input.slots[0]?.split(".")[0];
  if (input.slots.some((slot) => slot.split(".")[0] !== entity))
    throw new Error("A batched report must name slots of one entity.");
  const execution = new ReportExecution({
    db,
    id: input.id,
    slots: input.slots,
    viewer,
    actor,
    services,
  });
  const reports: EntityReportManyOut["reports"] = [];
  for (const slot of input.slots) {
    if (slot === "task.briefing")
      throw new Error("task.briefing does not support a record scope.");
    reports.push({
      slot,
      report: foldRepeatedRows(await execution.read(REPORTS[slot])),
    });
  }
  return { reports };
}
