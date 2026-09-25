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
  getProductTagOptions,
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
  attachProductComponentsWorkflow,
  backfillProductUpcImagesWorkflow,
  createManyProductsWorkflow,
  detachProductComponentsWorkflow,
  discardProductWorkflow,
  getProductInventoryEntriesWorkflow,
  getProductQuantitySummariesWorkflow,
  getProductSummariesWorkflow,
  listProductComponentsWorkflow,
  markProductsUsdaUnavailableWorkflow,
  mergeProductsWorkflow,
  quickCreateProductWorkflow,
  searchProductsWorkflow,
  setProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";

const productShortcodes = bindShortcodeResolver("product");

export const productHandlers = implementOperationDomain(productContract, {
  search: searchProductsWorkflow,
  resolveNames: (context, input) =>
    resolveProductNames(context.readDb, input.names),
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
  tagOptions: (context) => getProductTagOptions(context.readDb),
  categoryDistribution: (context) => getCategoryDistribution(context.readDb),
  manufacturerOptions: (context) =>
    getProductManufacturerOptions(context.readDb),
  externalIdSourceOptions: (context) =>
    getProductExternalIdSourceOptions(context.readDb),
  getByShortcodes: (context, input) =>
    getProductsByShortcodes(context.readDb, input.shortcodes),
  merge: mergeProductsWorkflow,
  mergePreview: async (context, input) => {
    const [keepId, mergeId] = await Promise.all([
      productShortcodes.one(context.db, input.keepId),
      productShortcodes.one(context.db, input.mergeId),
    ]);
    return previewProductMergeDecisions(context.db, { keepId, mergeId });
  },
  projectUses: async (context, input) =>
    listProductProjectUses(
      context.readDb,
      await productShortcodes.one(context.readDb, input.productId),
    ),
  purchases: async (context, input) =>
    listProductPurchases(
      context.readDb,
      await productShortcodes.one(context.readDb, input.productId),
    ),
  components: listProductComponentsWorkflow,
  kitComponentRows: async (context, input) =>
    listKitComponentRows(
      context.readDb,
      await productShortcodes.all(context.readDb, input.parentProductIds),
      context.usdaClient,
    ),
  kitMembership: async (context, input) =>
    listKitMembership(
      context.readDb,
      await productShortcodes.one(context.readDb, input.productId),
    ),
  attachComponents: attachProductComponentsWorkflow,
  detachComponents: detachProductComponentsWorkflow,
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
