import {
  productContract,
  productStreamsContract,
} from "~/contracts/product.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
  getProductsByShortcodes,
  resolveProductNames,
} from "~/server/repo/product";
import {
  listKitComponentRows,
  listKitMembership,
} from "~/server/repo/product-components";
import { previewProductMergeDecisions } from "~/server/repo/product/merge";
import { listProductProjectUses } from "~/server/repo/project";
import { listProductPurchases } from "~/server/repo/purchase-products";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  findOrCreateByCode,
  findOrCreateByUPC,
} from "~/server/services/product-orchestration.service";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  applyProductUpcDataWorkflow,
  backfillProductUpcImagesWorkflow,
  createManyProductsWorkflow,
  discardProductWorkflow,
  getProductInventoryEntriesWorkflow,
  getProductQuantitySummariesWorkflow,
  getProductSummariesWorkflow,
  listProductComponentsWorkflow,
  markProductsUsdaUnavailableWorkflow,
  quickCreateProductWorkflow,
  searchProductsWorkflow,
  setProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";

const productShortcodes = bindShortcodeResolver("product");

export const productHandlers = implementOperationDomain(productContract, {
  search: searchProductsWorkflow,
  resolveNames: (context, input) =>
    resolveProductNames(context.db, input.names),
  summaries: getProductSummariesWorkflow,
  quantitySummaries: getProductQuantitySummariesWorkflow,
  inventoryEntriesByIds: getProductInventoryEntriesWorkflow,
  quickCreate: quickCreateProductWorkflow,
  applyUpcData: applyProductUpcDataWorkflow,
  findOrCreateByUPC: (context, input) =>
    findOrCreateByUPC(
      context.db,
      context.usdaClient,
      context.upcLookupClient,
      input.upc,
      input.defaultName,
      context.actorContext,
    ),
  findOrCreateByCode: (context, input) =>
    findOrCreateByCode(
      context.db,
      context.usdaClient,
      context.upcLookupClient,
      input,
      context.actorContext,
    ),
  categoryDistribution: (context) => getCategoryDistribution(context.db),
  manufacturerOptions: (context) => getProductManufacturerOptions(context.db),
  externalIdSourceOptions: (context) =>
    getProductExternalIdSourceOptions(context.db),
  getByShortcodes: (context, input) =>
    getProductsByShortcodes(context.db, input.shortcodes),
  mergePreview: async (context, input) => {
    const [keepId, mergeId] = await Promise.all([
      productShortcodes.one(context.db, input.keepId),
      productShortcodes.one(context.db, input.mergeId),
    ]);
    return previewProductMergeDecisions(context.db, { keepId, mergeId });
  },
  projectUses: async (context, input) =>
    listProductProjectUses(
      context.db,
      await productShortcodes.one(context.db, input.productId),
    ),
  purchases: async (context, input) =>
    listProductPurchases(
      context.db,
      await productShortcodes.one(context.db, input.productId),
    ),
  components: listProductComponentsWorkflow,
  kitComponentRows: async (context, input) =>
    listKitComponentRows(
      context.db,
      await productShortcodes.all(context.db, input.parentProductIds),
      context.usdaClient,
    ),
  kitMembership: async (context, input) =>
    listKitMembership(
      context.db,
      await productShortcodes.one(context.db, input.productId),
    ),
  setProjectUses: setProductProjectUsesWorkflow,
  discard: discardProductWorkflow,
});

export const productStreamHandlers = implementSubscriptionDomain(
  productStreamsContract,
  {
    createMany: (context, input, signal) =>
      createManyProductsWorkflow(context, input, signal),
    markUsdaUnavailableMany: (context, input, signal) =>
      markProductsUsdaUnavailableWorkflow(context, input, signal),
    backfillUPCImages: (context, _input, signal) =>
      backfillProductUpcImagesWorkflow(context, signal),
  },
);
