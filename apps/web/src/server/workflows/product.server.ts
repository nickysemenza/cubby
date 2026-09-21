import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
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
  type productQuantitySummaryBatchInput,
  type productQuickCreatePayload,
  type productShortcodesInput,
  type productSummariesInput,
  productTopLevelOut,
} from "@cubby/schemas/product";
import type { productResolveNamesInput } from "@cubby/schemas/product";
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
  productSearchInput,
} from "@cubby/schemas/product-workflow";
import type {
  productProjectUsesInput,
  productProjectUsesSetInput,
} from "@cubby/schemas/project";
import type { productPurchasesInput } from "@cubby/schemas/purchase";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { executeEntity } from "~/server/entity-kernel";
import {
  discardProductUnits,
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  getProductTagOptions,
  productSearch,
  resolveProductNames,
  quickCreateProduct,
} from "~/server/repo/product";
import {
  attachProductComponents,
  detachProductComponents,
  listKitComponentRows,
  listKitMembership,
  listProductComponents,
} from "~/server/repo/product-components";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";
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
  applyUpcDataWithSideEffects,
  findOrCreateByCode,
  findOrCreateByUPC,
  importUpcImageBackfillCandidate,
  selectUpcImageBackfill,
  summarizeUpcImageBackfill,
} from "~/server/services/product-orchestration.service";
import {
  createProductWithFood,
  createProductWriteActions,
  getProductSummaries,
  updateProductWithFood,
} from "~/server/services/product.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import {
  bindWorkflow,
  bindBulkWorkflow,
  defineBulkWorkflow,
  type BulkWorkflowSummary,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export type ProductWorkflowContext = ReturnType<typeof requireActor>;

const productShortcodes = bindShortcodeResolver("product");
const projectShortcodes = bindShortcodeResolver("project");
const inventoryShortcodes = bindShortcodeResolver("inventory");

export { productSearchInput };

export const searchProductsWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productSearchInput>>(
    "product.search",
  )
    .call("read", async ({ context }, { input }) => {
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
        (item) =>
          !lexical.data.some((lexicalItem) => lexicalItem.id === item.id),
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
    })
    .output(({ read }) => read),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productSearchInput>,
  ) => ({ context, input }),
);

export const applyProductUpcDataWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productApplyUpcInput>>(
    "product.applyUpcData",
  )
    .call("id", async ({ context }, { input }) =>
      productShortcodes.one(context.db, input.id),
    )
    .commit("result", async ({ context }, { input, id }) =>
      applyUpcDataWithSideEffects(
        {
          db: context.db,
          product: createProductWriteActions(context.db, context.usdaClient),
          recipeCosting: context.services.recipeCosting,
          upcLookupClient: context.upcLookupClient,
        },
        { ...input, id },
        context.actorContext,
      ),
    )
    .output(({ result }) => result),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productApplyUpcInput>,
  ) => ({ context, input }),
);

export const getProductSummariesWorkflow = defineWorkflowOperation(
  "product.summaries",
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productSummariesInput>,
  ) =>
    getProductSummaries(
      context.readDb,
      context.usdaClient,
      input.ids,
      input.include,
    ),
);

export const getProductQuantitySummariesWorkflow = bindWorkflow(
  workflow<
    ProductWorkflowContext,
    z.output<typeof productQuantitySummaryBatchInput>
  >("product.quantitySummaries")
    .call("ids", async ({ context }, { input }) =>
      productShortcodes.all(context.readDb, input.ids),
    )
    .call("summaries", async ({ context }, { input, ids }) => {
      const byId = await loadProductQuantitySummaries(context.readDb, ids);
      const summaries: Record<string, ProductQuantitySummaryOut> = {};
      for (const [index, shortcode] of input.ids.entries())
        summaries[shortcode] = byId.get(ids[index]!)!;
      return summaries;
    })
    .output(({ summaries }) => summaries),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productQuantitySummaryBatchInput>,
  ) => ({ context, input }),
);

export const getProductInventoryEntriesWorkflow = bindWorkflow(
  workflow<
    ProductWorkflowContext,
    z.output<typeof productInventoryEntriesBatchInput>
  >("product.inventoryEntriesByIds")
    .call("entries", async ({ context }, { input }) => {
      if (input.ids.length === 0) return {};
      const ids = await productShortcodes.all(context.readDb, input.ids);
      const byId = await loadProductInventoryEntries(context.readDb, ids);
      const entries: Record<string, ProductListInventoryEntryOut[]> = {};
      for (const [index, shortcode] of input.ids.entries())
        entries[shortcode] = byId.get(ids[index]!) ?? [];
      return entries;
    })
    .output(({ entries }) => entries),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productInventoryEntriesBatchInput>,
  ) => ({ context, input }),
);

export const quickCreateProductWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productQuickCreatePayload>>(
    "product.quickCreate",
  )
    .commit("product", async ({ context }, { input }) => {
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
        entity: { entity: "product", id: entityId },
        source: "product.quickCreate",
      });
      return product;
    })
    .output(({ product }) => product),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productQuickCreatePayload>,
  ) => ({ context, input }),
);

export const findOrCreateProductByUpcWorkflow = defineWorkflowOperation(
  "product.findOrCreateByUPC",
  (
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
    ),
);

export const findOrCreateProductByCodeWorkflow = defineWorkflowOperation(
  "product.findOrCreateByCode",
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productFindOrCreateByCodeInput>,
  ) =>
    findOrCreateByCode(
      context.db,
      context.usdaClient,
      context.upcLookupClient,
      input,
      context.actorContext,
    ),
);

export const resolveProductNamesWorkflow = defineWorkflowOperation(
  "product.resolveNames",
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productResolveNamesInput>,
  ) => resolveProductNames(context.readDb, input.names),
);

export const getProductTagOptionsWorkflow = defineWorkflowOperation(
  "product.tagOptions",
  (context: ProductWorkflowContext) => getProductTagOptions(context.readDb),
);
export const getProductCategoryDistributionWorkflow = defineWorkflowOperation(
  "product.categoryDistribution",
  (context: ProductWorkflowContext) => getCategoryDistribution(context.readDb),
);
export const getProductManufacturerOptionsWorkflow = defineWorkflowOperation(
  "product.manufacturerOptions",
  (context: ProductWorkflowContext) =>
    getProductManufacturerOptions(context.readDb),
);
export const getProductExternalIdSourceOptionsWorkflow =
  defineWorkflowOperation(
    "product.externalIdSourceOptions",
    (context: ProductWorkflowContext) =>
      getProductExternalIdSourceOptions(context.readDb),
  );
export const getProductsByShortcodesWorkflow = defineWorkflowOperation(
  "product.getByShortcodes",
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productShortcodesInput>,
  ) => getProductsByShortcodes(context.readDb, input.shortcodes),
);

export const mergeProductsWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof mergeProductsInput>>(
    "product.merge",
  )
    .commit("result", async ({ context }, { input }) => {
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
    })
    .output(({ result }) => result),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof mergeProductsInput>,
  ) => ({ context, input }),
);

export const listProductProjectUsesWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productProjectUsesInput>>(
    "product.projectUses",
  )
    .call("productId", async ({ context }, { input }) =>
      productShortcodes.one(context.readDb, input.productId),
    )
    .call("uses", async ({ context }, { productId }) =>
      listProductProjectUses(context.readDb, productId),
    )
    .output(({ uses }) => uses),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productProjectUsesInput>,
  ) => ({ context, input }),
);
export const listProductPurchasesWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productPurchasesInput>>(
    "product.purchases",
  )
    .call("productId", async ({ context }, { input }) =>
      productShortcodes.one(context.readDb, input.productId),
    )
    .call("purchases", async ({ context }, { productId }) =>
      listProductPurchases(context.readDb, productId),
    )
    .output(({ purchases }) => purchases),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productPurchasesInput>,
  ) => ({ context, input }),
);
export const listProductComponentsWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productComponentsInput>>(
    "product.components",
  )
    .call("productId", async ({ context }, { input }) =>
      productShortcodes.one(context.readDb, input.parentProductId),
    )
    .call("components", async ({ context }, { productId }) =>
      listProductComponents(context.readDb, productId),
    )
    .output(({ components }) => components),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productComponentsInput>,
  ) => ({ context, input }),
);
export const listKitComponentRowsWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof kitComponentRowsInput>>(
    "product.kitComponentRows",
  )
    .call("productIds", async ({ context }, { input }) =>
      productShortcodes.all(context.readDb, input.parentProductIds),
    )
    .call("rows", async ({ context }, { productIds }) =>
      listKitComponentRows(context.readDb, productIds, context.usdaClient),
    )
    .output(({ rows }) => rows),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof kitComponentRowsInput>,
  ) => ({ context, input }),
);
export const listKitMembershipWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof kitMembershipsInput>>(
    "product.kitMembership",
  )
    .call("productId", async ({ context }, { input }) =>
      productShortcodes.one(context.readDb, input.productId),
    )
    .call("memberships", async ({ context }, { productId }) =>
      listKitMembership(context.readDb, productId),
    )
    .output(({ memberships }) => memberships),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof kitMembershipsInput>,
  ) => ({ context, input }),
);

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

export const attachProductComponentsWorkflow = bindWorkflow(
  workflow<
    ProductWorkflowContext,
    z.output<typeof attachProductComponentsInput>
  >("product.attachComponents")
    .call("resolved", async ({ context }, { input }) =>
      resolveComponentEntries(context, input),
    )
    .commit("result", async ({ context }, { resolved }) =>
      attachProductComponents(
        context.db,
        resolved.parentProductId,
        resolved.components,
        context.actorContext,
      ),
    )
    .output(({ result }) => result),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof attachProductComponentsInput>,
  ) => ({ context, input }),
);
export const detachProductComponentsWorkflow = bindWorkflow(
  workflow<
    ProductWorkflowContext,
    z.output<typeof detachProductComponentsInput>
  >("product.detachComponents")
    .call("resolved", async ({ context }, { input }) =>
      Promise.all([
        productShortcodes.one(context.db, input.parentProductId),
        productShortcodes.all(context.db, input.componentProductIds),
      ]),
    )
    .commit("result", async ({ context }, { resolved }) =>
      detachProductComponents(
        context.db,
        resolved[0],
        resolved[1],
        context.actorContext,
      ),
    )
    .output(({ result }) => result),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof detachProductComponentsInput>,
  ) => ({ context, input }),
);
export const setProductProjectUsesWorkflow = bindWorkflow(
  workflow<ProductWorkflowContext, z.output<typeof productProjectUsesSetInput>>(
    "product.setProjectUses",
  )
    .call("resolved", async ({ context }, { input }) =>
      Promise.all([
        productShortcodes.one(context.db, input.productId),
        projectShortcodes.all(context.db, input.projectIds),
      ]),
    )
    .commit("result", async ({ context }, { resolved }) =>
      setProductProjectUses(
        context.db,
        resolved[0],
        resolved[1],
        context.actorContext,
      ),
    )
    .output(({ result }) => result),
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productProjectUsesSetInput>,
  ) => ({ context, input }),
);

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
  (
    context: ProductWorkflowContext,
    input: z.output<typeof productDiscardInput>,
  ) => ({ context, input }),
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
