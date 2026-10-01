import type { IngredientId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import { productExternalIdCollisionsOut } from "@cubby/schemas/product";
import type {
  ProductListInventoryEntryOut,
  ProductQuantitySummaryOut,
  productApplyUpcInput,
  productCreateManyInput,
  productDiscardInput,
  productInventoryEntriesBatchInput,
  productMarkUsdaUnavailableManyInput,
  productQuantitySummaryBatchInput,
  productQuickCreatePayload,
  productSummariesInput,
} from "@cubby/schemas/product";
import {
  type CreateManyProductResult,
  productSearchInput,
} from "@cubby/schemas/product-workflow";
import type { productProjectUsesSetInput } from "@cubby/schemas/project";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { z } from "zod";

import {
  productContract,
  productStreamsContract,
} from "~/contracts/product.contract";
import { getErrorMessage } from "~/lib/error-utils";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  listKitComponentRows,
  listKitMembership,
  listProductComponents,
} from "~/server/repo/product-components";
import {
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
} from "~/server/repo/product/analytics";
import { createProductWithInventory } from "~/server/repo/product/capture";
import {
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  patchProductExternalIds,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product/crud";
import { discardProductUnits } from "~/server/repo/product/discard";
import { findProductExternalIdCollisions } from "~/server/repo/product/external-id-collisions";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import { previewProductMergeDecisions } from "~/server/repo/product/merge";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";
import { resolveProductNames } from "~/server/repo/product/resolve-names";
import {
  listProductProjectUses,
  setProductProjectUses,
} from "~/server/repo/project/tools";
import { listProductPurchases } from "~/server/repo/purchase-products";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import type { requireActor } from "~/server/request-context";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { verifyProductImages } from "~/server/services/image-verification.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  applyUpcDataWithSideEffects,
  findOrCreateByCode,
  findOrCreateByUPC,
  importUpcImageBackfillCandidate,
  lookupUPC,
  selectUpcImageBackfill,
  summarizeUpcImageBackfill,
} from "~/server/services/product-orchestration.service";
import {
  createProductWithFood,
  createProductWriteActions,
  getProductSummaries,
  getProductWithFood,
  updateProductWithFood,
} from "~/server/services/product.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  bindWorkflow,
  bindBulkWorkflow,
  defineBulkWorkflow,
  type BulkWorkflowSummary,
  workflow,
} from "~/server/workflow-runtime";

export type ProductWorkflowContext = ReturnType<typeof requireActor>;

const productShortcodes = bindShortcodeResolver("product");
const projectShortcodes = bindShortcodeResolver("project");
const inventoryShortcodes = bindShortcodeResolver("inventory");

export { productSearchInput };

async function searchProducts(
  context: ProductWorkflowContext,
  input: z.output<typeof productSearchInput>,
) {
  const { filters, pagination } = input;
  const lexical = await productSearch(
    context.db,
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
  const semantic = await semanticProductCandidates(context.db, nameQuery, 5);
  const semanticIds = semantic
    .filter((candidate) => candidate.similarity >= 0.75)
    .map((candidate) => parseEntityId("product", candidate.item.entityId));
  const semanticItems = (
    await getProductPickerItemsByIds(context.db, semanticIds)
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

async function applyProductUpcData(
  context: ProductWorkflowContext,
  input: z.output<typeof productApplyUpcInput>,
) {
  const id = await productShortcodes.one(context.db, input.id);
  return applyUpcDataWithSideEffects(
    {
      db: context.db,
      product: createProductWriteActions(context.db, context.usdaClient),
      recipeCosting: context.services.recipeCosting,
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
  getProductSummaries(context.db, context.usdaClient, input.ids, input.include);

async function getProductQuantitySummaries(
  context: ProductWorkflowContext,
  input: z.output<typeof productQuantitySummaryBatchInput>,
) {
  const ids = await productShortcodes.all(context.db, input.ids);
  const byId = await loadProductQuantitySummaries(context.db, ids);
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
  const ids = await productShortcodes.all(context.db, input.ids);
  const byId = await loadProductInventoryEntries(context.db, ids);
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
      categoryId:
        input.categoryId == null
          ? null
          : await resolveLiveShortcode(
              context.db,
              input.categoryId,
              "productCategory",
            ),
    },
    context.actorContext,
  );
  const entityId = await productShortcodes.one(context.db, product.id);
  await runMutationSideEffects(context.db, {
    action: "created",
    entity: { entity: "product", id: entityId },
    source: "product.quickCreate",
  });
  return product;
}

async function setProjectUses(
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

export const discardProductWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productDiscardInput>>(
    "product.discard",
  )
    .call("resolved", async ({ context }, { input }) => ({
      productId: await productShortcodes.one(context.db, input.productId),
      inventoryEntryId:
        input.adjustInventory && input.inventoryEntryId
          ? await inventoryShortcodes.one(context.db, input.inventoryEntryId)
          : null,
    }))
    .commit("result", async ({ context }, { input, resolved }) =>
      discardProductUnits(
        context.db,
        {
          productId: resolved.productId,
          quantity: input.quantity,
          trade: input.trade,
          date: input.date,
          reason: input.reason,
          inventoryEntryId: resolved.inventoryEntryId,
        },
        context.actorContext,
      ),
    )
    .effect("indexed", async ({ context }, { result }) =>
      runMutationSideEffectsForEntities(context.db, [
        {
          action: "created",
          entity: { entity: "expense", id: result.expenseId },
          source: "product.discard",
        },
        ...(result.inventory
          ? [
              {
                action: result.inventory.removed
                  ? ("deleted" as const)
                  : ("updated" as const),
                entity: {
                  entity: "inventory" as const,
                  id: result.inventory.entryId,
                },
                source: "product.discard",
              },
            ]
          : []),
      ]),
    )
    .effect("recipesRecomputed", async ({ context }, { result }) =>
      recomputeRecipesForPriceAffectedProducts(
        context.db,
        context.services.recipeCosting,
        result.priceAffectedProductIds,
        "product.discard",
      ),
    )
    .output(({ result }) => ({
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
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    })),
);

type CreateProductItem = z.output<typeof productCreateManyInput>[number];
const createManyProductsDefinition = defineBulkWorkflow({
  name: "product.createMany",
  items: workflow<ProductWorkflowContext, CreateProductItem[]>(
    "product.createMany.items",
  ).output(({ input }) => input),
  item: workflow<ProductWorkflowContext, CreateProductItem>(
    "product.createMany.item",
  )
    .commit("created", async ({ context }, { input }) =>
      createProductWithFood(
        context.db,
        context.usdaClient,
        input,
        context.actorContext,
      ),
    )
    .effect("indexed", async ({ context }, { created }) =>
      runMutationSideEffects(context.db, {
        action: "created",
        entity: { entity: "product", id: created.entityId },
        source: "product.createMany",
      }),
    )
    .effect("ingredientId", async ({ context }, { created }) => {
      if (!created.output.ingredient?.id) return null;
      const id = await resolveLiveShortcode(
        context.db,
        created.output.ingredient.id,
        "ingredient",
      );
      return id ? parseEntityId("ingredient", id) : null;
    })
    .output(({ ingredientId }) => ingredientId),
  finalize: workflow<
    ProductWorkflowContext,
    BulkWorkflowSummary<CreateProductItem, IngredientId | null>
  >("product.createMany.finalize")
    .commit("recipesRecomputed", async ({ context }, { input }) =>
      context.services.recipeCosting.recomputeForIngredients(
        input.succeeded.flatMap(({ result }) => (result ? [result] : [])),
        { source: "product.createMany" },
      ),
    )
    .output(({ input }): CreateManyProductResult => ({
      created: input.succeeded.length,
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
      failed: input.failed.map(({ index, item, error }) => ({
        index,
        name: item.name,
        error: getErrorMessage(error),
      })),
    })),
  onItemError: "continue",
  progress: () => undefined,
});
export const createManyProductsWorkflow = bindBulkWorkflow(
  createManyProductsDefinition,
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productCreateManyInput>,
    signal: AbortSignal = new AbortController().signal,
  ) => ({ context, input, signal }),
);

const markProductsUsdaUnavailableDefinition = defineBulkWorkflow({
  name: "product.markUsdaUnavailableMany",
  items: workflow<
    ProductWorkflowContext,
    z.output<typeof productMarkUsdaUnavailableManyInput>
  >("product.markUsdaUnavailableMany.items").output(({ input }) => input.ids),
  item: workflow<
    ProductWorkflowContext,
    z.output<typeof productMarkUsdaUnavailableManyInput>["ids"][number]
  >("product.markUsdaUnavailableMany.item")
    .call("id", async ({ context }, { input }) =>
      productShortcodes.one(context.db, input),
    )
    .commit("updated", async ({ context }, { id }) =>
      updateProductWithFood(
        context.db,
        context.usdaClient,
        id,
        { usdaUnavailable: true },
        context.actorContext,
      ),
    )
    .effect("indexed", async ({ context }, { id }) =>
      runMutationSideEffects(context.db, {
        action: "updated",
        entity: { entity: "product", id },
        source: "product.markUsdaUnavailableMany",
      }),
    )
    .output(() => undefined),
  finalize: workflow<
    ProductWorkflowContext,
    BulkWorkflowSummary<
      z.output<typeof productMarkUsdaUnavailableManyInput>["ids"][number],
      undefined
    >
  >("product.markUsdaUnavailableMany.finalize").output(({ input }) => ({
    updated: input.succeeded.length,
  })),
  onItemError: "stop",
  progress: () => undefined,
});
export const markProductsUsdaUnavailableWorkflow = bindBulkWorkflow(
  markProductsUsdaUnavailableDefinition,
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productMarkUsdaUnavailableManyInput>,
    signal: AbortSignal = new AbortController().signal,
  ) => ({ context, input, signal }),
);

const backfillProductUpcImagesDefinition = defineBulkWorkflow({
  name: "product.backfillUPCImages",
  items: workflow<ProductWorkflowContext, undefined>(
    "product.backfillUPCImages.select",
  )
    .call("candidates", async ({ context }) =>
      selectUpcImageBackfill(context.db),
    )
    .output(({ candidates }) => candidates),
  item: workflow<
    ProductWorkflowContext,
    Awaited<ReturnType<typeof selectUpcImageBackfill>>[number]
  >("product.backfillUPCImages.item")
    .commit("result", async ({ context }, { input }) =>
      importUpcImageBackfillCandidate(
        context.db,
        context.upcLookupClient,
        input,
      ),
    )
    .output(({ result }) => result),
  finalize: workflow<
    ProductWorkflowContext,
    BulkWorkflowSummary<
      Awaited<ReturnType<typeof selectUpcImageBackfill>>[number],
      Awaited<ReturnType<typeof importUpcImageBackfillCandidate>>
    >
  >("product.backfillUPCImages.finalize").output(({ input }) => {
    const summary = summarizeUpcImageBackfill(
      input.succeeded.map(({ result }) => result),
    );
    return {
      found: summary.found,
      imported: summary.imported,
      failed: summary.failed,
      skipped: summary.skipped,
    };
  }),
  concurrency: 10,
  progressCadence: "window",
  onItemError: "stop",
  progress: () => undefined,
});
export const backfillProductUpcImagesWorkflow = bindBulkWorkflow(
  backfillProductUpcImagesDefinition,
  (context: ProductWorkflowContext, signal?: AbortSignal) => ({
    context,
    input: undefined,
    signal,
  }),
);

export const productHandlers = implementOperationDomain(productContract, {
  createWithInventory: createProductWithInventory,
  search: searchProducts,
  resolveNames: (context, input) =>
    resolveProductNames(context.db, input.names),
  summaries: getProductSummariesWorkflow,
  quantitySummaries: getProductQuantitySummaries,
  inventoryEntriesByIds: getProductInventoryEntriesWorkflow,
  quickCreate: quickCreateProductWorkflow,
  applyUpcData: applyProductUpcData,
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
  components: async (context, input) =>
    listProductComponents(
      context.db,
      await productShortcodes.one(context.db, input.parentProductId),
    ),
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
  setProjectUses,
  discard: discardProductWorkflow,
  lookupUpc: (context, input) =>
    lookupUPC(
      context.db,
      context.usdaClient,
      context.upcLookupClient,
      input.upc,
    ),
  externalIdCollisions: async (context, input) =>
    productExternalIdCollisionsOut.parse(
      await findProductExternalIdCollisions(context.db, input),
    ),
  patchExternalIds: async (context, input) => {
    const id = await productShortcodes.one(context.db, input.id);
    await patchProductExternalIds(context.db, id, input, context.actorContext);
    return getProductWithFood(context.db, context.usdaClient, id);
  },
  verifyImages: async (context, input) => {
    const id = await productShortcodes.one(context.db, input.id);
    await verifyProductImages(context.db, id);
    return getProductWithFood(context.db, context.usdaClient, id);
  },
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
