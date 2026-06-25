/**
 * Product Router - Uses service layer
 *
 * Products integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the product service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type IngredientId,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import {
  productCategory,
  productCreateInput,
  productFiltersSchema,
  productQuickCreatePayload,
  productTopLevelOut,
  productUpdateData,
} from "@cubby/schemas/product";
import { recomputeSummary } from "@cubby/schemas/recipe";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { foodSummary, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { countActiveInventoryForProduct } from "~/server/repo/inventory/crud";
import {
  deleteProducts,
  getCategoryDistribution,
  getProductByShortcode,
  getProductsByShortcodes,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product";
import { importImageFromUPC } from "~/server/services/image-import";
import { productWithFoodOut } from "~/server/services/product.service";
import {
  backfillUPCImages as backfillUPCImagesService,
  findOrCreateByUPC as findOrCreateByUPCService,
} from "~/server/services/product-orchestration.service";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized CRUD procedures using factory (create + update are
// customized below — create imports UPC images, update eagerly recomputes).
const { getByID, list } = createEntityCrudProcedures({
  schemas: {
    createInput: productCreateInput,
    // Defaults-stripped so a partial update never resets an omitted field (e.g.
    // wiping fdc_id / unitMappings). See productUpdateData.
    updateInput: productUpdateData,
    output: productWithFoodOut,
    filters: productFiltersSchema,
    idSchema: productId,
  },
  repository: {
    getByID: async (services, id: ProductId) => {
      return await services.services.product.getProductByID(id);
    },
    list: async (services, filters, sort, pagination, groupBy) => {
      return await services.services.product.productList(
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        filters.categoryFilter,
        sort,
        pagination,
        groupBy,
      );
    },
    create: async (services, data) => {
      return await services.services.product.createProduct(
        data,
        services.actorContext,
      );
    },
    update: async (services, id: ProductId, data) => {
      return await services.services.product.updateProduct(
        id,
        data,
        services.actorContext,
      );
    },
  },
  entityName: "product",
});

// Lightweight typeahead for product-picker comboboxes. Same filters/pagination
// shape as `list`, but the repo skips relation joins AND the per-row USDA food
// enrichment `list` does — pickers only need {id, name, manufacturer}, so the
// cross-Worker USDA batch (list's long pole) has no business on this path.
const { list: search } = createEntityListProcedure({
  schemas: {
    output: productTopLevelOut,
    filters: productFiltersSchema,
  },
  repository: {
    list: async (services, filters, sort, pagination) =>
      productSearch(
        services.db,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        filters.categoryFilter,
        sort,
        pagination,
      ),
  },
  entityName: "product",
});

// Custom create procedure: imports UPC images + eagerly recomputes the new
// product's recipes (linking a product makes its ingredient costable). The bulk
// `createMany` path stays deferred (mark-stale → drain) so it doesn't recompute
// shared recipes once per product.
const create = protectedProcedure
  .input(productCreateInput)
  .output(productWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    // Create the product
    const product = await ctx.services.product.createProduct(
      input,
      ctx.actorContext,
    );

    // If product has a UPC, try to import image from UPC lookup (non-blocking)
    if (input.upc) {
      try {
        await importImageFromUPC(
          ctx.db,
          ctx.upcLookupClient,
          input.upc,
          product.id,
        );
      } catch (error) {
        console.error(`[product.create] Image import failed:`, error);
      }
    }

    const ingredientId = product.ingredient?.id;
    const recipesRecomputed = ingredientId
      ? await ctx.services.recipeCosting.recomputeForIngredient(ingredientId)
      : 0;
    return {
      ...product,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated: 0 },
    };
  });

// Custom update: a product's price/USDA link feeds recipe cost via its linked
// ingredient, so recompute every dependent recipe eagerly (covers UI + MCP) and
// report the count. Inventory-valuation recompute is added here too (stage D).
const update = protectedProcedure
  .input(z.object({ id: productId, data: productUpdateData }))
  .output(productWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    const result = await ctx.services.product.updateProduct(
      input.id,
      input.data,
      ctx.actorContext,
    );
    const ingredientId = result.ingredient?.id;
    const recipesRecomputed = ingredientId
      ? await ctx.services.recipeCosting.recomputeForIngredient(ingredientId)
      : 0;
    // updateProduct already resynced inventory valuations in its tx when the
    // price changed (amount × price); report how many entries that covered, and
    // refresh the persisted per-location valuation rollups those entries feed.
    const inventoryValuationsUpdated =
      input.data.price !== undefined
        ? await countActiveInventoryForProduct(ctx.db, input.id)
        : 0;
    if (input.data.price !== undefined) {
      await ctx.services.locationValuation.recompute();
    }
    return {
      ...result,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated },
    };
  });

// One-click "Apply" for the Problems page "Better UPC data available" panel:
// pull the (cached) UPC lookup and fill ONLY the fields still empty — never
// clobber a value the user already set. Manufacturer/price go through
// updateProduct (which resyncs inventory valuations and lets us recompute
// dependent recipes, since price feeds cost); the image is imported separately.
// Mirrors the field mapping in findOrCreateByUPC and the recompute in `update`.
const applyUpcData = protectedProcedure
  .input(z.object({ id: productId, upc: upc }))
  .output(productWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    const current = await ctx.services.product.getProductByID(input.id);
    const lookup = await ctx.upcLookupClient.lookup(input.upc);

    // Build a partial update from the gaps the lookup can actually fill.
    const data: { manufacturer?: string; price?: number } = {};
    const lookupManufacturer = lookup?.manufacturer ?? lookup?.brand ?? null;
    if (
      lookupManufacturer != null &&
      isUnspecifiedManufacturer(current.manufacturer) &&
      !isUnspecifiedManufacturer(lookupManufacturer)
    ) {
      data.manufacturer = lookupManufacturer;
    }
    if (current.price == null && lookup?.priceDollars != null) {
      data.price = lookup.priceDollars;
    }

    const priceChanged = data.price !== undefined;
    if (Object.keys(data).length > 0) {
      await ctx.services.product.updateProduct(
        input.id,
        data,
        ctx.actorContext,
      );
    }

    // Image is a separate write (R2 import + association); only when missing.
    if (current.images.length === 0 && lookup?.imageUrl) {
      try {
        await importImageFromUPC(
          ctx.db,
          ctx.upcLookupClient,
          input.upc,
          input.id,
        );
      } catch (error) {
        console.error(`[product.applyUpcData] Image import failed:`, error);
      }
    }

    // Re-fetch so the returned payload reflects every write (incl. the image).
    const result = await ctx.services.product.getProductByID(input.id);
    const ingredientId = result.ingredient?.id;
    const recipesRecomputed =
      priceChanged && ingredientId
        ? await ctx.services.recipeCosting.recomputeForIngredient(ingredientId)
        : 0;
    const inventoryValuationsUpdated = priceChanged
      ? await countActiveInventoryForProduct(ctx.db, input.id)
      : 0;
    if (priceChanged) {
      await ctx.services.locationValuation.recompute();
    }
    return {
      ...result,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated },
    };
  });

// Lazy USDA food resolution for a page of products. The products table renders
// immediately from `list` (food = null) and then fills the "USDA Food" column
// from this batch — keeping the cross-Worker USDA round-trip off the navigation
// critical path. Capped at one page's worth of ids.
const foodForIds = protectedProcedure
  .input(z.object({ ids: z.array(productId).max(200) }))
  .output(z.array(z.object({ id: productId, food: foodSummary.nullable() })))
  .query(async ({ ctx, input }) => {
    return await ctx.services.product.foodForProductIds(input.ids);
  });

// Quick create a product with minimal data (just name required)
const quickCreate = protectedProcedure
  .input(productQuickCreatePayload)
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    return await quickCreateProduct(
      ctx.db,
      {
        name: input.name,
        manufacturer: input.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: input.upc ?? null,
        expectedQuantity: input.expectedQuantity ?? null,
        model: input.model ?? null,
        price: input.price ?? null,
      },
      ctx.actorContext,
    );
  });

// Find or create a product by UPC code
// Checks local DB first, then USDA, then UPC worker, then creates with defaults
const findOrCreateByUPC = protectedProcedure
  .input(
    z.object({
      upc: upc,
      defaultName: z.string().optional(),
    }),
  )
  .output(productTopLevelOut)
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
  .output(
    z.array(
      z.object({
        category: productCategory.nullable(),
        productCount: z.number(),
        locations: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            count: z.number(),
          }),
        ),
      }),
    ),
  )
  .query(async ({ ctx }) => {
    return await getCategoryDistribution(ctx.db);
  });

// Batch lookup: multiple products by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(z.object({ shortcodes: z.array(z.string()) }))
  .output(z.array(productTopLevelOut))
  .query(async ({ ctx, input }) => {
    return await getProductsByShortcodes(ctx.db, input.shortcodes);
  });

// Get product by shortcode (e.g., P-X7K9)
const getByShortcode = protectedProcedure
  .input(z.object({ shortcode: z.string() }))
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
  recipesRecomputed: number;
  failed: { index: number; name: string; error: string }[];
};
const createMany = protectedProcedure
  .input(z.array(productCreateInput).min(1).max(50))
  .mutation(async function* ({ ctx, input }) {
    const failed: { index: number; name: string; error: string }[] = [];
    const ingredientIds: IngredientId[] = [];
    yield* streamItems<(typeof input)[number], never, CreateManyResult>(
      input,
      async (item) => {
        const product = await ctx.services.product.createProduct(
          item,
          ctx.actorContext,
        );
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
          recipesRecomputed:
            await ctx.services.recipeCosting.recomputeForIngredients(
              ingredientIds,
            ),
          failed,
        }),
      },
    );
  });

// Batch "no USDA food exists" flag for the workbench's "Mark no-USDA" action, so
// those products drop out of the link-USDA worklist and switch to manual entry.
// Streamed with per-id progress; each update is its own tx.
const markUsdaUnavailableMany = protectedProcedure
  .input(z.object({ ids: z.array(productId).min(1).max(100) }))
  .mutation(async function* ({ ctx, input }) {
    yield* streamItems<(typeof input.ids)[number], never, { updated: number }>(
      input.ids,
      async (id) => {
        await ctx.services.product.updateProduct(
          id,
          { usdaUnavailable: true },
          ctx.actorContext,
        );
      },
      { finalize: (summary) => ({ updated: summary.succeeded }) },
    );
  });

const deleteItem = createDeleteProcedure<ProductId>(async (services, ids) => {
  await deleteProducts(services.db, ids, services.actorContext);
}, productId);

export const productRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  getByShortcodes,
  list,
  search,
  foodForIds,
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
