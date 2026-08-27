import type { IngredientId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  type mergeProductsInput,
  type ProductListInventoryEntryOut,
  type ProductQuantitySummaryOut,
  type productApplyUpcInput,
  type productCreateManyInput,
  type productDiscardInput,
  type productFindOrCreateByCodeInput,
  type productFindOrCreateByUPCInput,
  type productInventoryEntriesBatchInput,
  type productMarkUsdaUnavailableManyInput,
  productMergeSummaryOut,
  type productMovementTimelineInput,
  type productQuantitySummaryBatchInput,
  type productQuickCreatePayload,
  type productRelationshipRouteInput,
  type productShortcodesInput,
  type productSummariesInput,
  productTopLevelOut,
} from "@cubby/schemas/product";
import type {
  AttachProductComponentsInput,
  attachProductComponentsInput,
  detachProductComponentsInput,
  kitComponentRowsInput,
  kitMembershipsInput,
  productComponentsInput,
} from "@cubby/schemas/product-components";
import {
  type CreateManyProductResult,
  productBackfillUpcImagesEvent,
  productCreateManyEvent,
  productMarkUsdaUnavailableEvent,
  productSearchInput,
} from "@cubby/schemas/product-workflow";
import type {
  productProjectUsesInput,
  productProjectUsesSetInput,
} from "@cubby/schemas/project";
import type { productPurchasesInput } from "@cubby/schemas/purchase";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { z } from "zod";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { executeEntity } from "~/server/entity-kernel";
import {
  discardProductUnits,
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
  getProductMovementTimeline,
  getProductPickerItemsByIds,
  getProductRelationshipRoute,
  getProductsByShortcodes,
  getProductTagOptions,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";
import {
  attachProductComponents,
  detachProductComponents,
  listKitComponentRows,
  listKitMembership,
  listProductComponents,
} from "~/server/repo/product-components";
import {
  listProductProjectUses,
  setProductProjectUses,
} from "~/server/repo/project";
import { listProductPurchases } from "~/server/repo/purchase-products";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import type { requireActor } from "~/server/request-context";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createProductWithFood,
  createProductWriteActions,
  getProductSummaries,
  updateProductWithFood,
} from "~/server/services/product.service";
import {
  applyUpcDataWithSideEffects,
  backfillUPCImages,
  findOrCreateByCode,
  findOrCreateByUPC,
} from "~/server/services/product-orchestration.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";

export type ProductWorkflowContext = ReturnType<typeof requireActor>;

const productShortcodes = bindShortcodeResolver("product");
const projectShortcodes = bindShortcodeResolver("project");
const inventoryShortcodes = bindShortcodeResolver("inventory");

export {
  productBackfillUpcImagesEvent,
  productCreateManyEvent,
  productMarkUsdaUnavailableEvent,
  productSearchInput,
};

export async function searchProductsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productSearchInput>,
) {
  const { filters, pagination } = input;
  const lexical = await productSearch(
    context.readDb,
    {
      nameFilter: filters.nameFilter,
      manufacturerFilter: filters.manufacturerFilter,
      upcFilter: filters.upcFilter,
      categoryFilter: filters.categoryFilter,
    },
    normalizeSorts(input.sort),
    pagination,
  );
  const nameQuery = filters.nameFilter?.trim() ?? "";
  if (
    !shouldUseSemanticComboboxFallback({
      lexicalCount: lexical.data.length,
      query: nameQuery,
      hasStructuredFilters: Boolean(
        filters.manufacturerFilter ||
          filters.upcFilter ||
          filters.categoryFilter,
      ),
    })
  ) {
    return buildPaginatedResponse(pagination, lexical.data, lexical.count);
  }
  const semantic = await semanticProductCandidates(
    context.readDb,
    nameQuery,
    5,
  );
  const semanticIds = semantic
    .filter((candidate) => candidate.similarity >= 0.75)
    .map((candidate) => parseEntityId("product", candidate.item.entityId));
  const semanticItems = (
    await getProductPickerItemsByIds(context.readDb, semanticIds)
  ).filter(
    (item) => !lexical.data.some((lexicalItem) => lexicalItem.id === item.id),
  );
  const data = [...lexical.data, ...semanticItems].slice(
    0,
    pagination.pageSize,
  );
  return buildPaginatedResponse(
    pagination,
    data,
    Math.max(lexical.count, lexical.data.length + semanticItems.length),
  );
}

export async function applyProductUpcDataWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productApplyUpcInput>,
) {
  const id = await productShortcodes.one(context.db, input.id);
  return applyUpcDataWithSideEffects(
    {
      db: context.db,
      product: createProductWriteActions(context.db, context.usdaClient),
      recipeCosting: context.services.recipeCosting,
      locationValuation: context.services.locationValuation,
      upcLookupClient: context.upcLookupClient,
    },
    { ...input, id },
    context.actorContext,
  );
}

export const getProductSummariesWorkflow = (
  context: ProductWorkflowContext,
  input: z.output<typeof productSummariesInput>,
) =>
  getProductSummaries(
    context.readDb,
    context.usdaClient,
    input.ids,
    input.include,
  );

export async function getProductQuantitySummariesWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productQuantitySummaryBatchInput>,
) {
  const ids = await productShortcodes.all(context.readDb, input.ids);
  const byId = await loadProductQuantitySummaries(context.readDb, ids);
  const summaries: Record<string, ProductQuantitySummaryOut> = {};
  for (const [index, shortcode] of input.ids.entries())
    summaries[shortcode] = byId.get(ids[index]!)!;
  return summaries;
}

export async function getProductInventoryEntriesWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productInventoryEntriesBatchInput>,
) {
  if (input.ids.length === 0) return {};
  const ids = await productShortcodes.all(context.readDb, input.ids);
  const byId = await loadProductInventoryEntries(context.readDb, ids);
  const entries: Record<string, ProductListInventoryEntryOut[]> = {};
  for (const [index, shortcode] of input.ids.entries())
    entries[shortcode] = byId.get(ids[index]!) ?? [];
  return entries;
}

export async function quickCreateProductWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productQuickCreatePayload>,
) {
  const product = await quickCreateProduct(
    context.db,
    {
      name: input.name,
      manufacturer: input.manufacturer ?? UNSPECIFIED_MANUFACTURER,
      upc: input.upc ?? null,
      isbn: input.isbn ?? null,
      expectedQuantity: input.expectedQuantity ?? null,
      model: input.model ?? null,
      price: input.price ?? null,
      category: input.category ?? null,
    },
    context.actorContext,
  );
  const entityId = await productShortcodes.one(context.db, product.id);
  await runMutationSideEffects(context.db, {
    action: "created",
    entity: { entityType: "product", entityId },
    source: "product.quickCreate",
  });
  return product;
}

export const findOrCreateProductByUpcWorkflow = (
  context: ProductWorkflowContext,
  input: z.output<typeof productFindOrCreateByUPCInput>,
) =>
  findOrCreateByUPC(
    context.db,
    context.usdaClient,
    context.upcLookupClient,
    input.upc,
    input.defaultName,
    context.actorContext,
  );

export const findOrCreateProductByCodeWorkflow = (
  context: ProductWorkflowContext,
  input: z.output<typeof productFindOrCreateByCodeInput>,
) =>
  findOrCreateByCode(
    context.db,
    context.usdaClient,
    context.upcLookupClient,
    input,
    context.actorContext,
  );

export const getProductTagOptionsWorkflow = (context: ProductWorkflowContext) =>
  getProductTagOptions(context.readDb);
export const getProductCategoryDistributionWorkflow = (
  context: ProductWorkflowContext,
) => getCategoryDistribution(context.readDb);
export const getProductManufacturerOptionsWorkflow = (
  context: ProductWorkflowContext,
) => getProductManufacturerOptions(context.readDb);
export const getProductExternalIdSourceOptionsWorkflow = (
  context: ProductWorkflowContext,
) => getProductExternalIdSourceOptions(context.readDb);
export const getProductMovementTimelineWorkflow = (
  context: ProductWorkflowContext,
  input: z.output<typeof productMovementTimelineInput>,
) => getProductMovementTimeline(context.readDb, input);
export const getProductsByShortcodesWorkflow = (
  context: ProductWorkflowContext,
  input: z.output<typeof productShortcodesInput>,
) => getProductsByShortcodes(context.readDb, input.shortcodes);

export async function mergeProductsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof mergeProductsInput>,
) {
  const result = await executeEntity(context, {
    action: "merge",
    entity: "product",
    data: input,
  });
  if (result.action !== "merge")
    throw new Error("Entity kernel returned the wrong action");
  return {
    product: productTopLevelOut.parse(result.item),
    mergeSummary: productMergeSummaryOut.parse(result.mergeSummary),
  };
}

export async function listProductProjectUsesWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productProjectUsesInput>,
) {
  return listProductProjectUses(
    context.readDb,
    await productShortcodes.one(context.readDb, input.productId),
  );
}
export async function listProductPurchasesWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productPurchasesInput>,
) {
  return listProductPurchases(
    context.readDb,
    await productShortcodes.one(context.readDb, input.productId),
  );
}
export async function getProductRelationshipRouteWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productRelationshipRouteInput>,
) {
  return getProductRelationshipRoute(
    context.readDb,
    await productShortcodes.one(context.readDb, input.productId),
  );
}
export async function listProductComponentsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productComponentsInput>,
) {
  return listProductComponents(
    context.readDb,
    await productShortcodes.one(context.readDb, input.parentProductId),
  );
}
export async function listKitComponentRowsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof kitComponentRowsInput>,
) {
  return listKitComponentRows(
    context.readDb,
    await productShortcodes.all(context.readDb, input.parentProductIds),
  );
}
export async function listKitMembershipWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof kitMembershipsInput>,
) {
  return listKitMembership(
    context.readDb,
    await productShortcodes.one(context.readDb, input.productId),
  );
}

async function resolveComponentEntries(
  context: ProductWorkflowContext,
  input: AttachProductComponentsInput,
) {
  const [parentProductId, componentIds] = await Promise.all([
    productShortcodes.one(context.db, input.parentProductId),
    productShortcodes.all(
      context.db,
      input.components.map((component) => component.productId),
    ),
  ]);
  return {
    parentProductId,
    components: input.components.map((component, index) => ({
      productId: componentIds[index]!,
      quantity: component.quantity,
    })),
  };
}

export async function attachProductComponentsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof attachProductComponentsInput>,
) {
  const resolved = await resolveComponentEntries(context, input);
  return attachProductComponents(
    context.db,
    resolved.parentProductId,
    resolved.components,
    context.actorContext,
  );
}
export async function detachProductComponentsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof detachProductComponentsInput>,
) {
  const [parentProductId, componentIds] = await Promise.all([
    productShortcodes.one(context.db, input.parentProductId),
    productShortcodes.all(context.db, input.componentProductIds),
  ]);
  return detachProductComponents(
    context.db,
    parentProductId,
    componentIds,
    context.actorContext,
  );
}
export async function setProductProjectUsesWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productProjectUsesSetInput>,
) {
  const [productId, projectIds] = await Promise.all([
    productShortcodes.one(context.db, input.productId),
    projectShortcodes.all(context.db, input.projectIds),
  ]);
  return setProductProjectUses(
    context.db,
    productId,
    projectIds,
    context.actorContext,
  );
}

export async function discardProductWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productDiscardInput>,
) {
  const productId = await productShortcodes.one(context.db, input.productId);
  const inventoryEntryId =
    input.adjustInventory && input.inventoryEntryId
      ? await inventoryShortcodes.one(context.db, input.inventoryEntryId)
      : null;
  const result = await discardProductUnits(
    context.db,
    {
      productId,
      quantity: input.quantity,
      date: input.date,
      reason: input.reason,
      inventoryEntryId,
    },
    context.actorContext,
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    context.db,
    [
      {
        action: "created",
        entity: { entityType: "expense", entityId: result.expenseId },
        source: "product.discard",
      },
      ...(result.inventory
        ? [
            {
              action: result.inventory.removed
                ? ("deleted" as const)
                : ("updated" as const),
              entity: {
                entityType: "inventory" as const,
                entityId: result.inventory.entryId,
              },
              source: "product.discard",
            },
          ]
        : []),
    ],
  );
  const recipeBatches = await recomputeRecipesForPriceAffectedProducts(
    context.db,
    context.services.recipeCosting,
    result.priceAffectedProductIds,
    "product.discard",
  );
  return {
    expenseId: parseShortcodeFor("expense", result.expenseShortcode),
    storedQuantity: result.storedQuantity,
    inventory: result.inventory
      ? {
          entryId: parseShortcodeFor(
            "inventory",
            result.inventory.entryShortcode,
          ),
          removed: result.inventory.removed,
          remainingValue: result.inventory.remainingValue,
        }
      : null,
    sideEffects: {
      backgroundBatches: [...backgroundBatches, ...recipeBatches],
    },
  };
}

export async function* createManyProductsWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productCreateManyInput>,
) {
  const failed: CreateManyProductResult["failed"] = [];
  const ingredientIds: IngredientId[] = [];
  yield* streamItems<(typeof input)[number], never, CreateManyProductResult>(
    input,
    async (item) => {
      const { output: product, entityId } = await createProductWithFood(
        context.db,
        context.usdaClient,
        item,
        context.actorContext,
      );
      await runMutationSideEffects(context.db, {
        action: "created",
        entity: { entityType: "product", entityId },
        source: "product.createMany",
      });
      if (product.ingredient?.id) {
        const ingredientId = await resolveLiveShortcode(
          context.db,
          product.ingredient.id,
          "ingredient",
        );
        if (ingredientId)
          ingredientIds.push(parseEntityId("ingredient", ingredientId));
      }
    },
    {
      onError: (item, index, error) =>
        failed.push({ index, name: item.name, error: getErrorMessage(error) }),
      finalize: async (summary) => ({
        created: summary.succeeded,
        sideEffects: {
          backgroundBatches:
            await context.services.recipeCosting.recomputeForIngredients(
              ingredientIds,
              { source: "product.createMany" },
            ),
        },
        failed,
      }),
    },
  );
}

export async function* markProductsUsdaUnavailableWorkflow(
  context: ProductWorkflowContext,
  input: z.output<typeof productMarkUsdaUnavailableManyInput>,
) {
  yield* streamItems<(typeof input.ids)[number], never, { updated: number }>(
    input.ids,
    async (shortcode) => {
      const id = await productShortcodes.one(context.db, shortcode);
      await updateProductWithFood(
        context.db,
        context.usdaClient,
        id,
        { usdaUnavailable: true },
        context.actorContext,
      );
      await runMutationSideEffects(context.db, {
        action: "updated",
        entity: { entityType: "product", entityId: id },
        source: "product.markUsdaUnavailableMany",
      });
    },
    { finalize: (summary) => ({ updated: summary.succeeded }) },
  );
}

export async function* backfillProductUpcImagesWorkflow(
  context: ProductWorkflowContext,
) {
  yield* streamProgress(
    backfillUPCImages(context.db, context.upcLookupClient),
    ({ found, imported, failed, skipped }) => ({
      found,
      imported,
      failed,
      skipped,
    }),
  );
}
