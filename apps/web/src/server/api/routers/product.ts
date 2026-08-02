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
  type ProductShortcode,
  productShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  patchProductExternalIdsInput,
  productApplyUpcInput,
  productCategoryDistributionOut,
  productCreateInput,
  productCreateManyInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productFiltersSchema,
  productFindOrCreateByUPCInput,
  productFindOrCreateByUPCOut,
  productListItemOut,
  productManufacturerOptionsOut,
  productMarkUsdaUnavailableManyInput,
  productPickerItemOut,
  productQuickCreatePayload,
  productShortcodeListOut,
  productShortcodesInput,
  productSortableFields,
  productSummariesInput,
  productSummariesOut,
  productTagOptionsOut,
  productTagSiblingsOut,
  productTopLevelOut,
  productUpdateData,
  productUpdateInput,
  productWithFoodAndSideEffectsOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import {
  productProjectUsesInput,
  productProjectUsesOut,
} from "@cubby/schemas/project";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { createAppError } from "~/server/errors/app-error";
import { findProductExternalIdCollisions } from "~/server/repo/data-quality";
import {
  deleteProducts,
  getCategoryDistribution,
  getProductManufacturerOptions,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  getProductsSharingTags,
  getProductTagOptions,
  patchProductExternalIds,
  productList as productListRepo,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product";
import { listProductProjectUses } from "~/server/repo/project";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import { verifyProductImages } from "~/server/services/image-verification.service";
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
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

async function resolveProductId(
  db: Parameters<typeof resolveLiveShortcode>[0],
  shortcode: ProductShortcode,
): Promise<ProductId> {
  const id = await resolveLiveShortcode(db, shortcode, "product");
  if (!id) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${shortcode} not found`);
  }
  return unsafeProductId(id);
}

async function resolveProductIds(
  db: Parameters<typeof resolveLiveShortcodes>[0],
  shortcodes: ProductShortcode[],
): Promise<ProductId[]> {
  const resolved = await resolveLiveShortcodes(db, shortcodes, "product");
  const missing = shortcodes.find((shortcode) => !resolved.has(shortcode));
  if (missing) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${missing} not found`);
  }
  return shortcodes.map((shortcode) =>
    unsafeProductId(resolved.get(shortcode)!),
  );
}

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
        filters,
        sort,
        pagination,
        groupBy,
      );
    },
  },
  entityName: "product",
});

// Create standardized detail/create/update procedures using the enriched schema
// (create + update are overridden below for side effects).
const { getByID, getByShortcode } = createEntityCrudWithoutListProcedures({
  entityName: "product",
  schemas: {
    createInput: productCreateInput,
    // Defaults-stripped so a partial update never resets an omitted field (e.g.
    // wiping fdc_id / unitMappings). See productUpdateData.
    updateInput: productUpdateData,
    output: productWithFoodOut,
    idSchema: productShortcode,
  },
  repository: {
    getByID: async (services, shortcode: ProductShortcode) => {
      const id = await resolveProductId(services.db, shortcode);
      return await getProductWithFood(services.db, services.usdaClient, id);
    },
    // Resolves the shortcode itself rather than reusing a plain repo-level
    // reader: `getByID` above returns the USDA-enriched shape
    // (`productWithFoodOut`), and the factory requires both procedures to
    // share one output schema, so this has to go through the same
    // enrichment `getByID` does.
    getByShortcode: async (services, shortcode) => {
      const id = await resolveLiveShortcode(services.db, shortcode, "product");
      return id
        ? await getProductWithFood(
            services.db,
            services.usdaClient,
            unsafeProductId(id),
          )
        : null;
    },
    create: async (services, data) => {
      const result = await createProductWithFood(
        services.db,
        services.usdaClient,
        data,
        services.actorContext,
      );
      return result.output;
    },
    update: async (services, shortcode: ProductShortcode, data) => {
      const id = await resolveProductId(services.db, shortcode);
      const result = await updateProductWithFood(
        services.db,
        services.usdaClient,
        id,
        data,
        services.actorContext,
      );
      return result.output;
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
      // Explicit pick, not a spread: `productSearch` ignores the presence
      // filters by design, and its narrowed param type makes that a compile
      // error rather than a silent drop.
      const lexical = await productSearch(
        services.db,
        {
          nameFilter: filters.nameFilter,
          manufacturerFilter: filters.manufacturerFilter,
          upcFilter: filters.upcFilter,
          categoryFilter: filters.categoryFilter,
        },
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
        .map((candidate) => unsafeProductId(candidate.item.entityId));
      const semanticItems = (
        await getProductPickerItemsByIds(services.db, semanticIds)
      ).filter(
        (item) =>
          !lexical.data.some((lexicalItem) => lexicalItem.id === item.id),
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
  .output(strictOutput(productWithFoodAndSideEffectsOut))
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
  .output(strictOutput(productWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    return await updateProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
      },
      id,
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
  .output(strictOutput(productWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    return await applyUpcDataWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
        upcLookupClient: ctx.upcLookupClient,
      },
      { ...input, id },
      ctx.actorContext,
    );
  });

const summaries = protectedProcedure
  .input(productSummariesInput)
  .output(strictOutput(productSummariesOut))
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
  .output(strictOutput(productTopLevelOut))
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
    const entityId = await resolveProductId(ctx.db, product.id);
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "product", entityId },
      source: "product.quickCreate",
    });
    return product;
  });

// Find or create a product by UPC code
// Checks local DB first, then USDA, then UPC worker, then creates with defaults
const findOrCreateByUPC = protectedProcedure
  .input(productFindOrCreateByUPCInput)
  .output(strictOutput(productFindOrCreateByUPCOut))
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
  .output(strictOutput(productCategoryDistributionOut))
  .query(async ({ ctx }) => {
    return await getCategoryDistribution(ctx.db);
  });

/**
 * Tag roster for the product list's Tags filter picklist — one grouped query
 * (see `getProductTagOptions`), same "cheap options query" shape as
 * `expense.vendorOptions`.
 */
const tagOptions = protectedProcedure
  .output(strictOutput(productTagOptionsOut))
  .query(async ({ ctx }) => {
    return await getProductTagOptions(ctx.db);
  });

const manufacturerOptions = protectedProcedure
  .output(strictOutput(productManufacturerOptionsOut))
  .query(({ ctx }) => getProductManufacturerOptions(ctx.db));

/**
 * "Fits with this" — every other product sharing a tag. Separate from
 * `getByID` so the detail page's main payload doesn't grow a join that only
 * one section reads, and so it re-fetches on its own when tags change.
 */
const tagSiblings = protectedProcedure
  .input(productShortcode)
  .output(strictOutput(productTagSiblingsOut))
  .query(async ({ ctx, input }) => {
    const siblings = await getProductsSharingTags(
      ctx.db,
      await resolveProductId(ctx.db, input),
    );

    return siblings.map(
      ({ shortcode, name, manufacturer, category, tags }) => ({
        id: unsafeProductShortcode(shortcode),
        name,
        manufacturer,
        category,
        tags,
      }),
    );
  });

const externalIdCollisions = protectedProcedure
  .input(productExternalIdCollisionInput)
  .output(strictOutput(productExternalIdCollisionsOut))
  .query(async ({ ctx, input }) =>
    productExternalIdCollisionsOut.parse(
      await findProductExternalIdCollisions(ctx.db, input),
    ),
  );

const patchExternalIds = protectedProcedure
  .input(patchProductExternalIdsInput)
  .output(strictOutput(productWithFoodOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    await patchProductExternalIds(ctx.db, id, input, ctx.actorContext);
    return await getProductWithFood(ctx.db, ctx.usdaClient, id);
  });

const verifyImages = protectedProcedure
  .input(productShortcode)
  .output(strictOutput(productWithFoodOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input);
    await verifyProductImages(ctx.db, id);
    return await getProductWithFood(ctx.db, ctx.usdaClient, id);
  });

// Batch lookup: multiple products by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(productShortcodesInput)
  .output(strictOutput(productShortcodeListOut))
  .query(async ({ ctx, input }) => {
    return await getProductsByShortcodes(ctx.db, input.shortcodes);
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
        const { output: product, entityId } = await createProductWithFood(
          ctx.db,
          ctx.usdaClient,
          item,
          ctx.actorContext,
        );
        await runMutationSideEffects(ctx.db, {
          action: "created",
          entity: { entityType: "product", entityId },
          source: "product.createMany",
        });
        if (product.ingredient?.id) {
          const ingredientId = await resolveLiveShortcode(
            ctx.db,
            product.ingredient.id,
            "ingredient",
          );
          if (ingredientId) ingredientIds.push(ingredientId as IngredientId);
        }
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
      async (shortcode) => {
        const id = await resolveProductId(ctx.db, shortcode);
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

const deleteItem = createDeleteProcedure<ProductShortcode>(
  async (services, shortcodes) => {
    const ids = await resolveProductIds(services.db, shortcodes);
    await deleteProducts(services.db, ids, services.actorContext);
    return await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "product" as const, entityId: id },
        source: "product.delete",
      })),
    );
  },
  productShortcode,
);

const projectUses = protectedProcedure
  .input(productProjectUsesInput)
  .output(strictOutput(productProjectUsesOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.productId);
    return listProductProjectUses(ctx.db, id);
  });

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
  tagOptions,
  manufacturerOptions,
  tagSiblings,
  externalIdCollisions,
  patchExternalIds,
  verifyImages,
  projectUses,
});
