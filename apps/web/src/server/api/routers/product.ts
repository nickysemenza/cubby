/**
 * Product Router - Uses service layer
 *
 * Products integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the product service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import {
  type IngredientId,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import {
  productApplyUpcInput,
  productCategoryDistributionOut,
  productCreateInput,
  productCreateManyInput,
  productFiltersSchema,
  productFindOrCreateByUPCInput,
  productFindOrCreateByUPCOut,
  productListItemOut,
  productMarkUsdaUnavailableManyInput,
  productPickerItemOut,
  productQuickCreatePayload,
  productShortcodeInput,
  productShortcodeListOut,
  productShortcodesInput,
  productSortableFields,
  productSummariesInput,
  productSummariesOut,
  productTopLevelOut,
  productUpdateData,
  productUpdateInput,
  productWithFoodAndSideEffectsOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import {
  deleteProducts,
  getCategoryDistribution,
  getProductByShortcode,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  productList as productListRepo,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createProductWithFood,
  createProductWriteActions,
  getProductSummaries,
  getProductWithFood,
  updateProductWithFood,
} from "~/server/services/product.service";
import {
  applyUpcDataWithSideEffects,
  backfillUPCImages as backfillUPCImagesService,
  createProductWithSideEffects,
  findOrCreateByUPC as findOrCreateByUPCService,
  updateProductWithSideEffects,
} from "~/server/services/product-orchestration.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Product lists are lean DB rows. Detail/create/update are enriched with USDA
// food and recipe usages, so the list contract is split from the detail one.
const { list } = createEntityListProcedure({
  schemas: {
    output: productListItemOut,
    filters: productFiltersSchema,
    sort: {
      sortableFields: productSortableFields,
      defaultSort: "createdAt",
      // Pinned, not derived from sortableFields: `buildOrderBy`'s groupBy
      // branch looks the field up as a real column, so a sort-only key like a
      // joined name would be accepted and then silently emit no grouping.
      groupableFields: ["category"] as const,
    },
  },
  repository: {
    list: async (services, filters, sort, pagination, groupBy) => {
      return await productListRepo(
        services.db,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        filters.categoryFilter,
        sort,
        pagination,
        groupBy,
        filters.inventoryPresenceFilter,
        filters.ingredientPresenceFilter,
        filters.categoryPresenceFilter,
      );
    },
  },
  entityName: "product",
});

// Create standardized detail/create/update procedures using the enriched schema
// (create + update are overridden below for side effects).
const { getByID } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: productCreateInput,
    // Defaults-stripped so a partial update never resets an omitted field (e.g.
    // wiping fdc_id / unitMappings). See productUpdateData.
    updateInput: productUpdateData,
    output: productWithFoodOut,
    idSchema: productId,
  },
  repository: {
    getByID: async (services, id: ProductId) => {
      return await getProductWithFood(services.db, services.usdaClient, id);
    },
    create: async (services, data) => {
      return await createProductWithFood(
        services.db,
        services.usdaClient,
        data,
        services.actorContext,
      );
    },
    update: async (services, id: ProductId, data) => {
      return await updateProductWithFood(
        services.db,
        services.usdaClient,
        id,
        data,
        services.actorContext,
      );
    },
  },
});

// Lightweight typeahead for product-picker comboboxes. Same filters/pagination
// shape as `list`, but the repo skips relation joins AND the per-row USDA food
// enrichment `list` does — pickers only need {id, name, manufacturer}, so the
// cross-Worker USDA batch (list's long pole) has no business on this path.
const { list: search } = createEntityListProcedure({
  schemas: {
    output: productPickerItemOut,
    filters: productFiltersSchema,
    sort: { sortableFields: productSortableFields, defaultSort: "name" },
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      const lexical = await productSearch(
        services.db,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        filters.categoryFilter,
        sort,
        pagination,
      );

      const nameQuery = filters.nameFilter?.trim() ?? "";
      const shouldUseSemantic = shouldUseSemanticComboboxFallback({
        lexicalCount: lexical.data.length,
        query: nameQuery,
        hasStructuredFilters: Boolean(
          filters.manufacturerFilter ||
            filters.upcFilter ||
            filters.categoryFilter,
        ),
      });
      if (!shouldUseSemantic) return lexical;

      const semantic = await semanticProductCandidates(
        services.db,
        nameQuery,
        5,
      );
      const semanticIds = semantic
        .filter((candidate) => candidate.similarity >= 0.75)
        .map((candidate) => productId.parse(candidate.item.id))
        .filter((id) => !lexical.data.some((item) => item.id === id));
      const semanticItems = await getProductPickerItemsByIds(
        services.db,
        semanticIds,
      );

      return {
        data: [...lexical.data, ...semanticItems].slice(0, pagination.pageSize),
        count: Math.max(
          lexical.count,
          lexical.data.length + semanticItems.length,
        ),
      };
    },
  },
  entityName: "product",
});

// Custom create procedure: imports UPC images + eagerly recomputes the new
// product's recipes (linking a product makes its ingredient costable). The bulk
// `createMany` path stays deferred (mark-stale → drain) so it doesn't recompute
// shared recipes once per product.
const create = protectedProcedure
  .input(productCreateInput)
  .output(productWithFoodAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    return await createProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
        upcLookupClient: ctx.upcLookupClient,
      },
      input,
      ctx.actorContext,
    );
  });

// Custom update: a product's price/USDA link feeds recipe cost via its linked
// ingredient, so recompute every dependent recipe eagerly (covers UI + MCP) and
// report the count. Inventory-valuation recompute is added here too (stage D).
const update = protectedProcedure
  .input(productUpdateInput)
  .output(productWithFoodAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    return await updateProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
      },
      input.id,
      input.data,
      ctx.actorContext,
    );
  });

// One-click "Apply" for the Problems page "Better UPC data available" panel:
// pull the (cached) UPC lookup and fill ONLY the fields still empty — never
// clobber a value the user already set. Manufacturer/price go through
// updateProduct (which resyncs inventory valuations and lets us recompute
// dependent recipes, since price feeds cost); the image is imported separately.
// Mirrors the field mapping in findOrCreateByUPC and the recompute in `update`.
const applyUpcData = protectedProcedure
  .input(productApplyUpcInput)
  .output(productWithFoodAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    return await applyUpcDataWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
        upcLookupClient: ctx.upcLookupClient,
      },
      input,
      ctx.actorContext,
    );
  });

const summaries = protectedProcedure
  .input(productSummariesInput)
  .output(productSummariesOut)
  .query(async ({ ctx, input }) => {
    return await getProductSummaries(
      ctx.db,
      ctx.usdaClient,
      input.ids,
      input.include,
    );
  });

// Quick create a product with minimal data (just name required)
const quickCreate = protectedProcedure
  .input(productQuickCreatePayload)
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    const product = await quickCreateProduct(
      ctx.db,
      {
        name: input.name,
        manufacturer: input.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: input.upc ?? null,
        expectedQuantity: input.expectedQuantity ?? null,
        model: input.model ?? null,
        price: input.price ?? null,
        category: input.category ?? null,
      },
      ctx.actorContext,
    );
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "product", entityId: product.id },
      source: "product.quickCreate",
    });
    return product;
  });

// Find or create a product by UPC code
// Checks local DB first, then USDA, then UPC worker, then creates with defaults
const findOrCreateByUPC = protectedProcedure
  .input(productFindOrCreateByUPCInput)
  .output(productFindOrCreateByUPCOut)
  .mutation(async ({ ctx, input }) => {
    return findOrCreateByUPCService(
      ctx.db,
      ctx.usdaClient,
      ctx.upcLookupClient,
      input.upc,
      input.defaultName,
      ctx.actorContext,
    );
  });

// Backfill UPC images for products that have a UPC but no images — streamed
// (per batch of 10) with a final scalar summary. The per-product `details` array
// the service collects isn't surfaced to the UI, so the streamed result omits it.
const backfillUPCImages = protectedProcedure.mutation(async function* ({
  ctx,
}) {
  yield* streamProgress(
    backfillUPCImagesService(ctx.db, ctx.upcLookupClient),
    ({ found, imported, failed, skipped }) => ({
      found,
      imported,
      failed,
      skipped,
    }),
  );
});

// Get category distribution for insights visualization
const categoryDistribution = protectedProcedure
  .output(productCategoryDistributionOut)
  .query(async ({ ctx }) => {
    return await getCategoryDistribution(ctx.db);
  });

// Batch lookup: multiple products by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(productShortcodesInput)
  .output(productShortcodeListOut)
  .query(async ({ ctx, input }) => {
    return await getProductsByShortcodes(ctx.db, input.shortcodes);
  });

// Get product by shortcode (e.g., P-X7K9)
const getByShortcode = protectedProcedure
  .input(productShortcodeInput)
  .output(productTopLevelOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getProductByShortcode(ctx.db, input.shortcode);
  });

// Batch-create products for the enrichment workbench's "Create products" action,
// streamed with per-row progress. Sequential single-row creates (each its own tx)
// so one bad row doesn't abort the rest; failures are reported per index for the
// client to surface/retry, then ONE deduped recompute over the affected recipes.
type CreateManyResult = {
  created: number;
  sideEffects: { backgroundBatches: BackgroundBatchRef[] };
  failed: { index: number; name: string; error: string }[];
};
const createMany = protectedProcedure
  .input(productCreateManyInput)
  .mutation(async function* ({ ctx, input }) {
    const failed: { index: number; name: string; error: string }[] = [];
    const ingredientIds: IngredientId[] = [];
    yield* streamItems<(typeof input)[number], never, CreateManyResult>(
      input,
      async (item) => {
        const product = await createProductWithFood(
          ctx.db,
          ctx.usdaClient,
          item,
          ctx.actorContext,
        );
        await runMutationSideEffects(ctx.db, {
          action: "created",
          entity: { entityType: "product", entityId: product.id },
          source: "product.createMany",
        });
        if (product.ingredient?.id) ingredientIds.push(product.ingredient.id);
      },
      {
        onError: (item, index, error) => {
          failed.push({
            index,
            name: item.name,
            error: getErrorMessage(error),
          });
        },
        // One deduped recompute over every affected recipe (not per-product),
        // since the bulk create links many products whose recipes overlap.
        finalize: async (summary) => ({
          created: summary.succeeded,
          sideEffects: {
            backgroundBatches:
              await ctx.services.recipeCosting.recomputeForIngredients(
                ingredientIds,
                { source: "product.createMany" },
              ),
          },
          failed,
        }),
      },
    );
  });

// Batch "no USDA food exists" flag for the workbench's "Mark no-USDA" action, so
// those products drop out of the link-USDA worklist and switch to manual entry.
// Streamed with per-id progress; each update is its own tx.
const markUsdaUnavailableMany = protectedProcedure
  .input(productMarkUsdaUnavailableManyInput)
  .mutation(async function* ({ ctx, input }) {
    yield* streamItems<(typeof input.ids)[number], never, { updated: number }>(
      input.ids,
      async (id) => {
        await updateProductWithFood(
          ctx.db,
          ctx.usdaClient,
          id,
          { usdaUnavailable: true },
          ctx.actorContext,
        );
        await runMutationSideEffects(ctx.db, {
          action: "updated",
          entity: { entityType: "product", entityId: id },
          source: "product.markUsdaUnavailableMany",
        });
      },
      { finalize: (summary) => ({ updated: summary.succeeded }) },
    );
  });

const deleteItem = createDeleteProcedure<ProductId>(async (services, ids) => {
  await deleteProducts(services.db, ids, services.actorContext);
  return await runMutationSideEffectsForEntities(
    services.db,
    ids.map((id) => ({
      action: "deleted" as const,
      entity: { entityType: "product" as const, entityId: id },
      source: "product.delete",
    })),
  );
}, productId);

export const productRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  getByShortcodes,
  list,
  summaries,
  search,
  create,
  createMany,
  markUsdaUnavailableMany,
  update,
  applyUpcData,
  delete: deleteItem,
  quickCreate,
  findOrCreateByUPC,
  backfillUPCImages,
  categoryDistribution,
});
