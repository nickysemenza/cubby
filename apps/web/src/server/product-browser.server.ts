import {
  productContract,
  productStreamsContract,
} from "~/contracts/product.contract";
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
  resolveProductNamesWorkflow,
  searchProductsWorkflow,
  setProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";

export const productHandlers = implementOperationDomain(productContract, {
  search: searchProductsWorkflow,
  resolveNames: resolveProductNamesWorkflow,
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
