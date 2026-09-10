import { product, productStreams } from "~/app/products/product.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  applyProductUpcDataWorkflow,
  attachProductComponentsWorkflow,
  backfillProductUpcImagesWorkflow,
  createManyProductsWorkflow,
  detachProductComponentsWorkflow,
  discardProductWorkflow,
  findOrCreateProductByCodeWorkflow,
  findOrCreateProductByUpcWorkflow,
  getProductCategoryDistributionWorkflow,
  getProductExternalIdSourceOptionsWorkflow,
  getProductInventoryEntriesWorkflow,
  getProductManufacturerOptionsWorkflow,
  getProductMovementTimelineWorkflow,
  getProductQuantitySummariesWorkflow,
  getProductSummariesWorkflow,
  getProductsByShortcodesWorkflow,
  getProductTagOptionsWorkflow,
  listKitComponentRowsWorkflow,
  listKitMembershipWorkflow,
  listProductComponentsWorkflow,
  listProductProjectUsesWorkflow,
  listProductPurchasesWorkflow,
  markProductsUsdaUnavailableWorkflow,
  mergeProductsWorkflow,
  quickCreateProductWorkflow,
  searchProductsWorkflow,
  setProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";

export const productHandlers = implementOperationDomain(product, {
  search: searchProductsWorkflow,
  summaries: getProductSummariesWorkflow,
  quantitySummaries: getProductQuantitySummariesWorkflow,
  inventoryEntriesByIds: getProductInventoryEntriesWorkflow,
  quickCreate: quickCreateProductWorkflow,
  applyUpcData: applyProductUpcDataWorkflow,
  findOrCreateByUPC: findOrCreateProductByUpcWorkflow,
  findOrCreateByCode: findOrCreateProductByCodeWorkflow,
  tagOptions: getProductTagOptionsWorkflow,
  categoryDistribution: getProductCategoryDistributionWorkflow,
  manufacturerOptions: getProductManufacturerOptionsWorkflow,
  externalIdSourceOptions: getProductExternalIdSourceOptionsWorkflow,
  movementTimeline: getProductMovementTimelineWorkflow,
  getByShortcodes: getProductsByShortcodesWorkflow,
  merge: mergeProductsWorkflow,
  projectUses: listProductProjectUsesWorkflow,
  purchases: listProductPurchasesWorkflow,
  components: listProductComponentsWorkflow,
  kitComponentRows: listKitComponentRowsWorkflow,
  kitMembership: listKitMembershipWorkflow,
  attachComponents: attachProductComponentsWorkflow,
  detachComponents: detachProductComponentsWorkflow,
  setProjectUses: setProductProjectUsesWorkflow,
  discard: discardProductWorkflow,
});

export const productStreamHandlers = implementSubscriptionDomain(
  productStreams,
  {
    createMany: (context, input, signal) =>
      createManyProductsWorkflow(context, input, signal),
    markUsdaUnavailableMany: (context, input, signal) =>
      markProductsUsdaUnavailableWorkflow(context, input, signal),
    backfillUPCImages: (context, _input, signal) =>
      backfillProductUpcImagesWorkflow(context, signal),
  },
);
