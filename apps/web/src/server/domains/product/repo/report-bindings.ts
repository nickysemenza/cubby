import { reportDependency } from "~/server/generic/entity-report/repo/dependency";
import { identityBuilder } from "~/server/generic/entity-report/repo/dependency";
import {
  productId,
  reportMember,
} from "~/server/generic/entity-report/repo/record-dependencies";
import {
  productCookbooksReport,
  productLabelsReport,
  productRecipeAppearancesReport,
  recordRunsReport,
} from "~/server/generic/entity-report/repo/records";
import {
  readProductSummaryRow,
  productPricingSummary,
  productSellersReport,
  productStockSummary,
  productContextSummary,
} from "~/server/generic/entity-report/repo/summary";

/** The stock and pricing slots of one request share a single Product read. */
const productSummaryRow = reportDependency(async (execution) =>
  readProductSummaryRow(
    execution.request.db,
    execution.request.id,
    execution.request.slots,
  ),
);

export const reportBindings = {
  "product.sellers": reportDependency(async (execution) => ({
    blocks: await productSellersReport(
      execution.request.db,
      await execution.read(productId),
    ),
  })),
  "product.pricing-summary": reportDependency(async (execution) => ({
    blocks: await productPricingSummary(
      execution.request.db,
      execution.request.id,
      await execution.read(productId),
      await execution.read(productSummaryRow),
    ),
  })),
  "product.stock-summary": reportDependency(async (execution) => ({
    blocks: await productStockSummary(
      execution.request.db,
      execution.request.id,
      await execution.read(productId),
      await execution.read(productSummaryRow),
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
  "product.labels": identityBuilder(productId, productLabelsReport),
  "product.cookbooks": identityBuilder(productId, productCookbooksReport),
  "product.recipe-appearances": identityBuilder(
    productId,
    productRecipeAppearancesReport,
  ),
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
};
